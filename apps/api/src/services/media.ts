import type { Deps } from '../types.js';

export async function presentMedia(deps: Deps, rows: Array<Record<string, unknown>>) {
  const expires = new Date(deps.now().getTime() + 3600_000);
  return Promise.all(
    rows.map(async (m) => ({
      id: m.id,
      kind: m.kind,
      status: m.status,
      originalFilename: m.original_filename,
      sizeBytes: Number(m.size_bytes),
      width: m.width,
      height: m.height,
      durationMs: m.duration_ms,
      videoCodec: m.video_codec,
      createdAt: m.created_at,
      thumbnailUrl: m.thumbnail_key ? await deps.storage.signedUrl(m.thumbnail_key as string, expires) : null,
      previewUrl: await deps.storage.signedUrl(m.storage_key as string, expires),
    })),
  );
}
