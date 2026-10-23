// Node version of packages/database/scripts/migrate.sh for hosts without psql (e.g. Vercel builds).
// Same table, same checksums (sha256 of the file bytes), same rules: each pending file runs in its
// own transaction; a changed, already-applied file stops the run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');
const dir = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/database/migrations');

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Map((await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations`).map((r) => [r.name, r.checksum]));
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const body = readFileSync(join(dir, name));
    const sum = createHash('sha256').update(body).digest('hex');
    const prev = applied.get(name);
    if (prev) {
      if (prev !== sum) throw new Error(`${name} was modified after being applied (checksum mismatch). Add a new migration instead.`);
      continue;
    }
    console.log(`Applying ${name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body.toString('utf8'));
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${sum})`;
    });
  }
  console.log('Migrations up to date.');
} finally {
  await sql.end();
}
