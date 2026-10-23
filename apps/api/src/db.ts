import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or an open transaction. */
export type Db = Sql | Tx;

export function createSql(url: string): Sql {
  // Serverless functions each hold their own pool; keep it small there. Connection poolers in
  // transaction mode (e.g. Neon's "-pooler" host) do not support named prepared statements.
  const serverless = Boolean(process.env.VERCEL);
  return postgres(url, {
    max: serverless ? 3 : 10,
    prepare: !/-pooler\./.test(url),
    idle_timeout: 30,
    // Return timestamps as Date and bigint counts as numbers where safe.
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
    onnotice: () => {},
  });
}
