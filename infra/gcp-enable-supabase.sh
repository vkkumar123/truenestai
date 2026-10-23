#!/usr/bin/env bash
# Switch a Cloud Run environment from sample data to Supabase. Run in Google Cloud Shell after
# infra/gcp-bootstrap.sh and after the Supabase tables exist:
#   cd ~/truenestai && git fetch -q origin && git checkout -q main && git pull -q && bash infra/gcp-enable-supabase.sh
# Asks for the three Supabase values without echoing them; they go straight into Secret Manager.
set -euo pipefail

ENV_NAME="${1:-staging}"
PROJECT_ID="${PROJECT_ID:-truenestai}"
TF="${HOME}/bin/terraform"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="${SCRIPT_DIR}/terraform"
[ -x "${TF}" ] || { echo "!! Run infra/gcp-bootstrap.sh first (it installs Terraform)."; exit 1; }
gcloud config set project "${PROJECT_ID}" >/dev/null
cd "${TF_DIR}"

# shellcheck source=infra/lib.sh
source "${SCRIPT_DIR}/lib.sh"

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
  if [ "$1" = supabase-url ]; then
    v="${v%/}"; v="${v%/rest/v1}"; v="${v%/}" # accept a pasted .../rest/v1/ and keep the base URL
    [[ "$v" =~ ^https://[a-z0-9]+\.supabase\.co$ ]] || { echo "!! expected https://<ref>.supabase.co"; exit 1; }
  fi
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
