#!/usr/bin/env bash
# Turn on on-demand research (search miss -> research -> save to the database) for a Cloud Run
# environment that already runs on Supabase. Run in Google Cloud Shell once the research code is
# deployed:
#   cd ~/truenestai && git fetch -q origin && git checkout -q main && git pull -q && bash infra/gcp-enable-research.sh
# Asks for the Anthropic API key without echoing it; generates RESEARCH_RUN_SECRET; wires both into
# Cloud Run; creates a Cloud Scheduler job that drains the research queue every 2 minutes.
set -euo pipefail

ENV_NAME="${1:-staging}"
PROJECT_ID="${PROJECT_ID:-truenestai}"
REGION="${REGION:-asia-south1}"
TF="${HOME}/bin/terraform"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="${SCRIPT_DIR}/terraform"
[ -x "${TF}" ] || { echo "!! Run infra/gcp-bootstrap.sh first (it installs Terraform)."; exit 1; }
gcloud config set project "${PROJECT_ID}" >/dev/null
cd "${TF_DIR}"
# shellcheck source=infra/lib.sh
source "${SCRIPT_DIR}/lib.sh"

grep -A6 "^\s*${ENV_NAME}\s*=" terraform.tfvars | grep -q 'data_backend *= *"supabase"' || {
  echo "!! ${ENV_NAME} is not on Supabase yet; run infra/gcp-enable-supabase.sh first."; exit 1; }

gcloud services enable cloudscheduler.googleapis.com
"${TF}" init -input=false -backend-config="bucket=${PROJECT_ID}-tfstate" >/dev/null

echo "==> 1/4 Creating the research secrets for ${ENV_NAME}"
"${TF}" apply -input=false -auto-approve \
  -target='google_secret_manager_secret.runtime' -target='google_secret_manager_secret_iam_member.runtime_access'

echo "==> 2/4 Storing values"
has_version() { [ -n "$(gcloud secrets versions list "$1" --filter='state=ENABLED' --format='value(name)' --limit=1)" ]; }
KEY_SECRET="truenest-${ENV_NAME}-anthropic-api-key"
if has_version "${KEY_SECRET}" && [ "${REPLACE_KEY:-0}" != 1 ]; then
  echo "   ${KEY_SECRET} already set (REPLACE_KEY=1 to change it)"
else
  read -rsp "Anthropic API key (console.anthropic.com > API keys; input hidden): " v; echo
  [[ "$v" == sk-ant-* ]] || { echo "!! that does not look like an Anthropic key (sk-ant-...)"; exit 1; }
  printf %s "$v" | gcloud secrets versions add "${KEY_SECRET}" --data-file=- >/dev/null
  unset v
  echo "   saved ${KEY_SECRET}"
fi
RUN_SECRET="truenest-${ENV_NAME}-research-run-secret"
if ! has_version "${RUN_SECRET}"; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add "${RUN_SECRET}" --data-file=- >/dev/null
  echo "   generated ${RUN_SECRET}"
fi

echo "==> 3/4 Wiring the secrets into Cloud Run"
set_tfvar research_ready true
"${TF}" apply -input=false -auto-approve

echo "==> 4/4 Cloud Scheduler job (every 2 minutes)"
url="$("${TF}" output -json service_urls | python3 -c "import json,sys; print(json.load(sys.stdin)['${ENV_NAME}'])")"
job="truenest-${ENV_NAME}-research"
action=create
gcloud scheduler jobs describe "${job}" --location="${REGION}" >/dev/null 2>&1 && action=update
# The header value is stored in the job config (visible to project owners), never printed here.
gcloud scheduler jobs "${action}" http "${job}" --location="${REGION}" \
  --schedule="*/2 * * * *" --time-zone="Asia/Kolkata" \
  --uri="${url}/api/internal/research/run" --http-method=POST \
  --$( [ "${action}" = create ] && echo headers || echo update-headers )="x-research-secret=$(gcloud secrets versions access latest --secret="${RUN_SECRET}")" \
  --attempt-deadline=300s --max-retry-attempts=0 >/dev/null
echo "   ${action}d ${job}"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${url}/")
echo
echo "==> Done. Research is on for ${url} (home page HTTP ${code})."
