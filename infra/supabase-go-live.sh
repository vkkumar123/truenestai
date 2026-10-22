#!/usr/bin/env bash
# One-time PRODUCTION database setup for TrueNest AI, run by the owner in Google Cloud Shell
# (or any machine that can open a Postgres connection; Claude's sandbox cannot).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/vkkumar123/truenestai/main/infra/supabase-go-live.sh)
#
# It asks for the Supabase database password (hidden input, never printed or saved), then:
#   1. applies supabase/migrations (ledger: private.schema_migrations)
#   2. marks the database as production (SAMPLE data is refused from then on)
#   3. loads reference data only (geography + source registry). No SAMPLE projects.
# Re-running is safe: migrations and the reference seed are idempotent.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-mludzbcozmsfkintmxlx}"
REGION="${SUPABASE_REGION:-ap-south-1}"
REPO_URL="https://github.com/vkkumar123/truenestai.git"
WORKDIR="${HOME}/truenest-go-live"

say() { printf '\n==> %s\n' "$*"; }

# Node 22+ is required (package scripts use --env-file-if-exists).
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  say "Installing Node 22 with nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
fi

say "Fetching the latest code"
if [ -d "$WORKDIR/.git" ]; then
  git -C "$WORKDIR" fetch -q origin main && git -C "$WORKDIR" reset -q --hard origin/main
else
  git clone -q "$REPO_URL" "$WORKDIR"
fi
cd "$WORKDIR"
npm ci --no-audit --no-fund --loglevel=error

printf '\nPaste your Supabase DATABASE password (input is hidden), then press Enter: '
read -rs DB_PASSWORD
echo
[ -n "$DB_PASSWORD" ] || { echo "No password entered."; exit 1; }

# Build connection strings without echoing the password. The direct host is IPv6-only, so the
# Supabase session pooler (IPv4, port 5432) is tried too. The pooler host depends on the project's
# region and cluster, so every known combination is tried (wrong ones answer "tenant not found").
export DB_PASSWORD PROJECT_REF REGION
CANDIDATES=$(node -e '
  const p = encodeURIComponent(process.env.DB_PASSWORD), ref = process.env.PROJECT_REF, first = process.env.REGION;
  const q = "?sslmode=no-verify";
  const regions = [first, "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-south-2",
    "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
    "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1"];
  const out = [`postgresql://postgres:${p}@db.${ref}.supabase.co:5432/postgres${q}`];
  for (const r of [...new Set(regions)])
    for (const c of ["aws-0", "aws-1", "aws-2"])
      out.push(`postgresql://postgres.${ref}:${p}@${c}-${r}.pooler.supabase.com:5432/postgres${q}`);
  console.log(out.join("\n"));')
unset DB_PASSWORD

say "Finding a working database connection (this can take a minute)"
SUPABASE_DB_URL=""
LOG=$(mktemp)
while IFS= read -r url; do
  if SUPABASE_DB_URL="$url" npx --no-install tsx --conditions=react-server scripts/db-migrate.ts --dry-run >"$LOG" 2>&1; then
    SUPABASE_DB_URL="$url"; grep '^database' "$LOG" || true; break
  fi
  if grep -qiE 'password authentication failed|28P01' "$LOG"; then
    rm -f "$LOG"
    echo "The database password was rejected. Copy it again (or reset it in Supabase > Project Settings > Database) and re-run."
    exit 1
  fi
  printf '.'
done <<< "$CANDIDATES"
echo
rm -f "$LOG"
[ -n "$SUPABASE_DB_URL" ] || { echo "Could not reach the database. Send Claude the output above."; exit 1; }
export SUPABASE_DB_URL

run() { npx --no-install tsx --conditions=react-server scripts/db-migrate.ts "$@"; }

say "1/3 Applying migrations";            run
say "2/3 Marking database as production"; run --mark-production
say "3/3 Loading reference data only";    run --seed=reference

unset SUPABASE_DB_URL
say "Done. Tell Claude: \"database migrated\"."
