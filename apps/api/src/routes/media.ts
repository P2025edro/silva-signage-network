import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireCompany } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { CompanyParams, uuid } from '../lib/http.js';
import { MediaRejected, processUpload } from '../lib/media.js';
import { presentMedia } from '../services/media.js';

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  r.get('/api/companies/:companyId/media', { schema: { tags: ['media'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    const rows = await deps.sql`SELECT * FROM media_assets WHERE company_id = ${req.params.companyId} AND deleted_at IS NULL ORDER BY created_at DESC`;
    return presentMedia(deps, rows);
  });

  r.post(
    '/api/companies/:companyId/media',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['media'], params: CompanyParams, consumes: ['multipart/form-data'] } },
    async (req, reply) => {
      requireCompany(req, deps, req.params.companyId, 'EDIT');
      const file = await req.file();
      if (!file) throw badRequest('Attach a file in the "file" field');
      const buf = await file.toBuffer();
      if (file.file.truncated) throw new HttpError(413, 'FILE_TOO_LARGE', 'File is too large');

      let processed;
      try {
        processed = await processUpload(buf, {
          maxImageBytes: deps.config.MEDIA_MAX_IMAGE_BYTES,
          maxVideoBytes: deps.config.MEDIA_MAX_VIDEO_BYTES,
          maxVideoSeconds: deps.config.MEDIA_MAX_VIDEO_SECONDS,
        });
      } catch (e) {
        if (e instanceof MediaRejected) throw new HttpError(422, 'MEDIA_REJECTED', e.message);
        throw e;
      }

      const id = randomUUID();
      const ext = processed.kind === 'VIDEO' ? 'mp4' : 'jpg';
      const base = `companies/${req.params.companyId}/media/${id}`;
      await deps.storage.put(`${base}/delivery.${ext}`, processed.delivery, processed.deliveryMime);
      await deps.storage.put(`${base}/thumb.jpg`, processed.thumbnail, 'image/jpeg');
      // Keep only a short, sanitised version of the client filename for display.
      const filename = (file.filename ?? 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

      await deps.sql.begin(async (tx) => {
        await tx`
          INSERT INTO media_assets (id, company_id, kind, status, original_filename, detected_mime, size_bytes, sha256, width, height,
            duration_ms, video_codec, storage_key, thumbnail_key, uploaded_by)
          VALUES (${id}, ${req.params.companyId}, ${processed.kind}, 'READY', ${filename}, ${processed.detectedMime}, ${processed.delivery.length},
            ${sha256(processed.delivery)}, ${processed.width}, ${processed.height}, ${processed.durationMs}, ${processed.videoCodec},
            ${`${base}/delivery.${ext}`}, ${`${base}/thumb.jpg`}, ${req.auth!.user.id})`;
        await audit(tx, {
          actorType: 'USER',
          actorId: req.auth!.user.id,
          companyId: req.params.companyId,
          action: 'media.uploaded',
          entityType: 'media',
          entityId: id,
          metadata: { kind: processed.kind, transcoded: processed.transcoded },
          ip: req.ip,
        });
      });
      const [row] = await deps.sql`SELECT * FROM media_assets WHERE id = ${id}`;
      reply.status(201);
      return (await presentMedia(deps, [row!]))[0];
    },
  );

  r.delete('/api/companies/:companyId/media/:mediaId', { schema: { tags: ['media'], params: CompanyParams.extend({ mediaId: uuid }) } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'EDIT');
    await deps.sql.begin(async (tx) => {
      const [used] = await tx`
          SELECT 1 FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id
          WHERE cm.media_asset_id = ${req.params.mediaId} AND c.deleted_at IS NULL AND c.status NOT IN ('DRAFT', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED', 'COMPLETED')`;
      if (used) throw conflict('This media is used by a submitted or live campaign', 'MEDIA_IN_USE');
      const [m] =
        await tx`UPDATE media_assets SET deleted_at = now() WHERE id = ${req.params.mediaId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL RETURNING id`;
      if (!m) throw notFound('Media');
      // Detach from drafts only; finished campaigns keep their history.
      await tx`DELETE FROM campaign_media cm USING campaigns c WHERE cm.campaign_id = c.id
          AND cm.media_asset_id = ${req.params.mediaId} AND c.status IN ('DRAFT', 'CHANGES_REQUESTED')`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'media.deleted',
        entityType: 'media',
        entityId: req.params.mediaId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });
};
