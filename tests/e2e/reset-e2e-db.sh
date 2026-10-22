#!/usr/bin/env bash
# Recreates the dedicated end-to-end database from migrations, then seeds a super admin.
# Refuses to touch any database whose name does not end in _e2e.
set -euo pipefail
: "${E2E_DATABASE_URL:=postgres://silva:silva_dev@localhost:5432/silva_signage_e2e}"
db_name="${E2E_DATABASE_URL##*/}"
if [[ "$db_name" != *_e2e ]]; then echo "Refusing: $db_name is not an _e2e database" >&2; exit 1; fi
admin_url="${E2E_DATABASE_URL%/*}/postgres"
export PGOPTIONS="-c client_min_messages=warning"
psql "$admin_url" -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $db_name WITH (FORCE)" -c "CREATE DATABASE $db_name"
DATABASE_URL="$E2E_DATABASE_URL" bash "$(dirname "$0")/../../packages/database/scripts/migrate.sh"
rm -rf "$(dirname "$0")/.storage"
(cd "$(dirname "$0")/../../apps/api" && NODE_ENV=test DATABASE_URL="$E2E_DATABASE_URL" APP_SECRET=e2e-secret-e2e-secret-e2e-secret-e2e-secret \
  SEED_ADMIN_EMAIL=admin@e2e.invalid SEED_ADMIN_PASSWORD=e2e-admin-password-123 SCRYPT_LOG_N=12 npx tsx src/scripts/seed.ts >/dev/null)
echo "E2E database ready."
