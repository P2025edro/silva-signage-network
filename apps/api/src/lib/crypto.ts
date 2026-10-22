import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
export const hmac = (secret: string, value: string): Buffer => createHmac('sha256', secret).update(value).digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

// ---- Passwords: scrypt (OWASP: N=2^17, r=8, p=1) ----------------------------
function scryptAsync(password: string, salt: Buffer, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16);
  const N = 2 ** logN;
  const key = await scryptAsync(password, salt, N);
  return `scrypt$${logN}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, logN, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !logN || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), 2 ** Number(logN));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Use at least 12 characters');
  if (password.length > 200) problems.push('Use at most 200 characters');
  return problems;
}

// ---- Symmetric encryption for secrets at rest (TOTP seeds) ----------------
function keyFor(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'silva-signage', purpose, 32));
}

export function encryptSecret(appSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(appSecret, 'secret-at-rest'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(appSecret: string, payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !enc) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(appSecret, 'secret-at-rest'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---- Pairing codes ---------------------------------------------------------
/** No 0/O, 1/I/L, so codes read cleanly off a TV across a room. */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalisePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashPairingCode(appSecret: string, code: string): Buffer {
  return hmac(appSecret, `pairing:${normalisePairingCode(code)}`);
}

// ---- Signed media URLs -----------------------------------------------------
export function signMediaKey(appSecret: string, key: string, expiresAtSec: number): string {
  return hmac(appSecret, `media:${key}:${expiresAtSec}`).toString('base64url');
}

export function verifyMediaSignature(appSecret: string, key: string, expiresAtSec: number, sig: string): boolean {
  const expected = Buffer.from(signMediaKey(appSecret, key, expiresAtSec));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
