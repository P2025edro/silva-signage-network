import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
/** Binaries can be supplied by path (e.g. bundled static builds on serverless hosts). */
const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_PATH || 'ffprobe';

export type DetectedType = { kind: 'IMAGE'; mime: 'image/jpeg' | 'image/png' | 'image/webp' } | { kind: 'VIDEO'; mime: 'video/mp4' };

/** Identify the file from its leading bytes. Extensions and client MIME types are ignored. */
export function sniffFileType(buf: Buffer): DetectedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'IMAGE', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'IMAGE', mime: 'image/png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'IMAGE', mime: 'image/webp' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    // ISO base media brands used by MP4 (excludes QuickTime 'qt  ' and HEIF images).
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand)) {
      return { kind: 'VIDEO', mime: 'video/mp4' };
    }
  }
  return null;
}

export interface MediaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxVideoSeconds: number;
  videoDisabled?: boolean;
}

/** Display constraints for 16:9 TVs. */
const MIN_WIDTH = 640;
const MIN_HEIGHT = 360;
const MAX_DIMENSION = 7680;
const DELIVERY_MAX_W = 1920;
const DELIVERY_MAX_H = 1080;

export class MediaRejected extends Error {}

export interface ProcessedMedia {
  kind: 'IMAGE' | 'VIDEO';
  detectedMime: string;
  deliveryMime: string;
  delivery: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  transcoded: boolean;
}

export async function processUpload(buf: Buffer, limits: MediaLimits): Promise<ProcessedMedia> {
  const type = sniffFileType(buf);
  if (!type) throw new MediaRejected('Unsupported file. Upload JPEG, PNG, WebP or MP4.');
  if (type.kind === 'VIDEO' && limits.videoDisabled) throw new MediaRejected('Video uploads are not available in this environment yet. Please upload a JPEG, PNG or WebP image.');
  return type.kind === 'IMAGE' ? processImage(buf, type.mime, limits) : processVideo(buf, limits);
}

async function processImage(buf: Buffer, mime: string, limits: MediaLimits): Promise<ProcessedMedia> {
  if (buf.length > limits.maxImageBytes) throw new MediaRejected(`Image exceeds ${Math.round(limits.maxImageBytes / 1048576)} MB`);
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
  } catch {
    throw new MediaRejected('The image could not be decoded');
  }
  const { width = 0, height = 0 } = meta;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) throw new MediaRejected(`Image must be at least ${MIN_WIDTH}×${MIN_HEIGHT}`);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new MediaRejected(`Image must be at most ${MAX_DIMENSION}px per side`);
  if (meta.pages && meta.pages > 1) throw new MediaRejected('Animated images are not supported');

  // Re-encode: strips metadata (EXIF/GPS) and any trailing payload, and fits 1080p.
  const delivery = await sharp(buf)
    .rotate()
    .resize(DELIVERY_MAX_W, DELIVERY_MAX_H, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumbnail = await sharp(delivery.data).resize(480, 270, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  return {
    kind: 'IMAGE',
    detectedMime: mime,
    deliveryMime: 'image/jpeg',
    delivery: delivery.data,
    thumbnail,
    width: delivery.info.width,
    height: delivery.info.height,
    durationMs: null,
    videoCodec: null,
    transcoded: true,
  };
}

interface ProbeResult {
  streams: Array<{ codec_type: string; codec_name?: string; profile?: string; width?: number; height?: number; pix_fmt?: string }>;
  format: { duration?: string; format_name?: string };
}

async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
    timeout: 30_000,
  });
  return JSON.parse(stdout) as ProbeResult;
}

/** H.264 High/Main/Baseline, yuv420p, ≤1080p is the safest decode target across Tizen/webOS/Android TV. */
function isDeliveryReady(p: ProbeResult): boolean {
  const v = p.streams.find((s) => s.codec_type === 'video');
  const audioOk = p.streams.filter((s) => s.codec_type === 'audio').every((s) => s.codec_name === 'aac');
  return Boolean(
    v &&
    v.codec_name === 'h264' &&
    v.pix_fmt === 'yuv420p' &&
    ['High', 'Main', 'Constrained Baseline', 'Baseline'].includes(v.profile ?? '') &&
    (v.width ?? 0) <= DELIVERY_MAX_W &&
    (v.height ?? 0) <= DELIVERY_MAX_H &&
    audioOk,
  );
}

async function processVideo(buf: Buffer, limits: MediaLimits): Promise<ProcessedMedia> {
  if (buf.length > limits.maxVideoBytes) throw new MediaRejected(`Video exceeds ${Math.round(limits.maxVideoBytes / 1048576)} MB`);
  const dir = await mkdtemp(join(tmpdir(), 'silva-media-'));
  try {
    const input = join(dir, 'input.mp4');
    await writeFile(input, buf);
    let info: ProbeResult;
    try {
      info = await probe(input);
    } catch {
      throw new MediaRejected('The video could not be read');
    }
    const v = info.streams.find((s) => s.codec_type === 'video');
    if (!v) throw new MediaRejected('The file has no video stream');
    const durationMs = Math.round(Number(info.format.duration ?? 0) * 1000);
    if (!durationMs) throw new MediaRejected('Video duration could not be determined');
    if (durationMs > limits.maxVideoSeconds * 1000) throw new MediaRejected(`Video must be ${limits.maxVideoSeconds} seconds or shorter`);
    if ((v.width ?? 0) < MIN_WIDTH || (v.height ?? 0) < MIN_HEIGHT) throw new MediaRejected(`Video must be at least ${MIN_WIDTH}×${MIN_HEIGHT}`);

    let output = input;
    let transcoded = false;
    if (!isDeliveryReady(info)) {
      output = join(dir, 'delivery.mp4');
      await run(
        FFMPEG(),
        [
          '-v',
          'error',
          '-y',
          '-i',
          input,
          '-vf',
          `scale='min(${DELIVERY_MAX_W},iw)':'min(${DELIVERY_MAX_H},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-level',
          '4.0',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'medium',
          '-crf',
          '21',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          output,
        ],
        { timeout: 10 * 60_000 },
      );
      transcoded = true;
    }
    const finalInfo = transcoded ? await probe(output) : info;
    const fv = finalInfo.streams.find((s) => s.codec_type === 'video')!;
    const thumbPath = join(dir, 'thumb.jpg');
    await run(
      FFMPEG(),
      ['-v', 'error', '-y', '-ss', String(Math.min(1, durationMs / 2000)), '-i', output, '-frames:v', '1', '-vf', 'scale=480:-2', thumbPath],
      {
        timeout: 60_000,
      },
    );
    return {
      kind: 'VIDEO',
      detectedMime: 'video/mp4',
      deliveryMime: 'video/mp4',
      delivery: transcoded ? await readFile(output) : buf,
      thumbnail: await readFile(thumbPath),
      width: fv.width ?? 0,
      height: fv.height ?? 0,
      durationMs,
      videoCodec: fv.codec_name ?? null,
      transcoded,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
