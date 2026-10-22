import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or an open transaction. */
export type Db = Sql | Tx;

export function createSql(url: string): Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 30,
    // Return timestamps as Date and bigint counts as numbers where safe.
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
    onnotice: () => {},
  });
}
