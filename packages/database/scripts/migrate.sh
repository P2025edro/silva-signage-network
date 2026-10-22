#!/usr/bin/env bash
# Applies pending SQL migrations in order, each in its own transaction.
# Usage: DATABASE_URL=postgres://... bash packages/database/scripts/migrate.sh
# Only additive migrations live in migrations/. Destructive changes need explicit approval.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
export PGOPTIONS="-c client_min_messages=warning"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" && pwd)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

for file in "$DIR"/*.sql; do
  name="$(basename "$file")"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  applied="$(psql "$DATABASE_URL" -tA -c "SELECT checksum FROM schema_migrations WHERE name = '$name'")"
  if [[ -n "$applied" ]]; then
    if [[ "$applied" != "$sum" ]]; then
      echo "ERROR: $name was modified after being applied (checksum mismatch). Add a new migration instead." >&2
      exit 1
    fi
    continue
  fi
  echo "Applying $name"
  {
    echo "BEGIN;"
    cat "$file"
    echo "INSERT INTO schema_migrations (name, checksum) VALUES ('$name', '$sum');"
    echo "COMMIT;"
  } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
done
echo "Migrations up to date."
