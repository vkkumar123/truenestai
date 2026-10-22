#!/usr/bin/env bash
# Switch a Cloud Run environment from sample data to Supabase. Run in Google Cloud Shell after
# infra/gcp-bootstrap.sh and after the Supabase tables exist:
#   cd ~/truenestai && git fetch -q origin && git checkout -q main && git pull -q && bash infra/gcp-enable-supabase.sh
# Asks for the three Supabase values without echoing them; they go straight into Secret Manager.
set -euo pipefail

ENV_NAME="${1:-staging}"
PROJECT_ID="${PROJECT_ID:-truenestai}"
TF="${HOME}/bin/terraform"
TF_DIR="$(cd "$(dirname "$0")/terraform" && pwd)"
[ -x "${TF}" ] || { echo "!! Run infra/gcp-bootstrap.sh first (it installs Terraform)."; exit 1; }
gcloud config set project "${PROJECT_ID}" >/dev/null
cd "${TF_DIR}"

set_tfvar() { # set_tfvar <key> <value> inside the ${ENV_NAME} block of terraform.tfvars
  python3 - "$ENV_NAME" "$1" "$2" <<'PY'
import re, sys
env, key, val = sys.argv[1:]
s = open("terraform.tfvars").read()
m = re.search(r'(^\s*' + re.escape(env) + r'\s*=\s*\{)(.*?)(^\s*\})', s, re.S | re.M)
if not m:
    sys.exit(f"!! No '{env}' block in terraform.tfvars")
body = m.group(2)
line = re.compile(r'^(\s*)' + re.escape(key) + r'\s*=.*$', re.M)
if line.search(body):
    body = line.sub(lambda x: f'{x.group(1)}{key} = {val}', body, count=1)
else:
    body = body.rstrip("\n") + f"\n    {key} = {val}\n"
open("terraform.tfvars", "w").write(s[:m.start(2)] + body + s[m.end(2):])
PY
}

"${TF}" init -input=false -backend-config="bucket=${PROJECT_ID}-tfstate" >/dev/null

echo "==> 1/3 Creating the Supabase secrets for ${ENV_NAME}"
set_tfvar data_backend '"supabase"'
set_tfvar secrets_ready false
"${TF}" apply -input=false -auto-approve \
  -target='google_secret_manager_secret.runtime' -target='google_secret_manager_secret_iam_member.runtime_access'

echo "==> 2/3 Storing values (input is hidden; copy them from Supabase > Project Settings > API)"
add_secret() {
  local name="truenest-${ENV_NAME}-$1" prompt="$2" v
  read -rsp "${prompt}: " v; echo
  [ -n "$v" ] || { echo "!! empty value"; exit 1; }
  printf %s "$v" | gcloud secrets versions add "${name}" --data-file=- >/dev/null
  echo "   saved ${name}"
}
add_secret supabase-url "Project URL (https://<ref>.supabase.co, nothing after .co)"
add_secret supabase-anon-key "anon public key"
add_secret supabase-service-role-key "service_role key"
if [ -z "$(gcloud secrets versions list "truenest-${ENV_NAME}-session-secret" --filter='state=ENABLED' --format='value(name)' --limit=1)" ]; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "truenest-${ENV_NAME}-session-secret" --data-file=- >/dev/null
  echo "   generated truenest-${ENV_NAME}-session-secret"
fi

echo "==> 3/3 Pointing Cloud Run at Supabase"
set_tfvar secrets_ready true
"${TF}" apply -input=false -auto-approve

url="$("${TF}" output -json service_urls | python3 -c "import json,sys; print(json.load(sys.stdin)['${ENV_NAME}'])")"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${url}/")
echo
echo "==> Done. ${url} now reads from Supabase (home page HTTP ${code})."
