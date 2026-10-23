import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { del as blobDel, get as blobGet, put as blobPut } from '@vercel/blob';
import { dirname, resolve, sep } from 'node:path';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import { signMediaKey } from './crypto.js';

/**
 * Private object storage. Objects are never public: clients get time-limited
 * URLs (HMAC-signed API URLs for local storage, presigned URLs for S3).
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Time-limited URL a browser or TV can load without other credentials. */
  signedUrl(key: string, expiresAt: Date): Promise<string>;
  /** Drivers served through the API's signed /api/media-files route: open the object for streaming. */
  open?(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number } | null>;
  read(key: string): Promise<Buffer>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]*$/;
function assertKey(key: string) {
  if (!KEY_PATTERN.test(key) || key.includes('..')) throw new Error(`Unsafe storage key: ${key}`);
}

export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(
    root: string,
    private readonly publicUrl: string,
    private readonly appSecret: string,
  ) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Storage path escapes root');
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async open(key: string, range?: { start: number; end: number }) {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p, range), size: s.size };
    } catch {
      return null;
    }
  }

  async signedUrl(key: string, expiresAt: Date): Promise<string> {
    assertKey(key);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = signMediaKey(this.appSecret, key, exp);
    return `${this.publicUrl}/api/media-files/${key}?exp=${exp}&sig=${sig}`;
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  constructor(private readonly config: Config) {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required for STORAGE_DRIVER=s3');
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(config.S3_ENDPOINT),
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
  }

  async read(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async signedUrl(key: string, expiresAt: Date): Promise<string> {
    // S3 presigned URLs are capped at 7 days.
    const seconds = Math.min(7 * 24 * 3600, Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { expiresIn: seconds });
  }
}

/**
 * Vercel Blob with a *private* store. Objects are not reachable without the store token, so the
 * API hands out the same HMAC-signed /api/media-files URLs as the local driver and streams the
 * object itself. Delivery files are re-encoded 1080p JPEGs (well under a megabyte), which suits
 * serverless response limits; video is disabled where this driver is used.
 */
export class BlobStorage implements Storage {
  constructor(
    private readonly token: string | undefined,
    private readonly publicUrl: string,
    private readonly appSecret: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    await blobPut(key, body, { access: 'private', contentType, token: this.token, addRandomSuffix: false, allowOverwrite: true });
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await blobDel(key, { token: this.token });
  }

  async read(key: string): Promise<Buffer> {
    assertKey(key);
    const res = await blobGet(key, { access: 'private', token: this.token });
    if (!res || !res.stream) throw new Error(`Blob not found: ${key}`);
    return Buffer.from(await new Response(res.stream as ReadableStream).arrayBuffer());
  }

  async open(key: string, range?: { start: number; end: number }) {
    let buf: Buffer;
    try {
      buf = await this.read(key);
    } catch {
      return null;
    }
    const part = range ? buf.subarray(range.start, range.end + 1) : buf;
    return { stream: Readable.from([part]), size: buf.length };
  }

  async signedUrl(key: string, expiresAt: Date): Promise<string> {
    assertKey(key);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return `${this.publicUrl}/api/media-files/${key}?exp=${exp}&sig=${signMediaKey(this.appSecret, key, exp)}`;
  }
}

export function createStorage(config: Config): Storage {
  if (config.STORAGE_DRIVER === 's3') return new S3Storage(config);
  if (config.STORAGE_DRIVER === 'blob') {
    // Either a read-write token or (on Vercel) a store id used with the deployment's OIDC token.
    if (!config.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new Error('Connect a Blob store (BLOB_READ_WRITE_TOKEN) for STORAGE_DRIVER=blob');
    return new BlobStorage(config.BLOB_READ_WRITE_TOKEN, config.API_PUBLIC_URL, config.APP_SECRET);
  }
  return new LocalStorage(config.STORAGE_LOCAL_DIR, config.API_PUBLIC_URL, config.APP_SECRET);
}
