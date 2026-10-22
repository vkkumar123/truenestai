#!/usr/bin/env bash
# One-time GCP setup for TrueNest. Run in Google Cloud Shell as a project Owner:
#   git clone -b infra/gcp-cloud-run https://github.com/vkkumar123/truenestai.git
#   cd truenestai && bash infra/gcp-bootstrap.sh
# Safe to re-run. Creates no keys; GitHub Actions authenticates through Workload Identity Federation.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-truenestai}"
REGION="${REGION:-asia-south1}"
STATE_BUCKET="${PROJECT_ID}-tfstate"
TF_DIR="$(cd "$(dirname "$0")/terraform" && pwd)"

echo "==> Project ${PROJECT_ID}, region ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

if [ "$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  echo "!! Billing is not enabled on ${PROJECT_ID}. Link a billing account at"
  echo "   https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID} and re-run."
  exit 1
fi

echo "==> Enabling the APIs Terraform needs to start"
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com

echo "==> Terraform state bucket gs://${STATE_BUCKET}"
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${STATE_BUCKET}" --location="${REGION}" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi

cd "${TF_DIR}"
if [ ! -f terraform.tfvars ]; then
  sed "s/^project_id = .*/project_id = \"${PROJECT_ID}\"/" terraform.tfvars.example > terraform.tfvars
  echo "==> Wrote ${TF_DIR}/terraform.tfvars (staging only, sample data)"
fi

echo "==> terraform apply"
terraform init -input=false -backend-config="bucket=${STATE_BUCKET}"
terraform apply -input=false

echo "==> Server Functions encryption key (generated here, never printed)"
KEY_SECRET="truenest-next-server-actions-key"
if [ -z "$(gcloud secrets versions list "${KEY_SECRET}" --filter='state=ENABLED' --format='value(name)' --limit=1)" ]; then
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add "${KEY_SECRET}" --data-file=-
fi

echo
echo "==> Done. Add these as GitHub repository VARIABLES (not secrets; none of them is sensitive):"
echo "    https://github.com/vkkumar123/truenestai/settings/variables/actions"
terraform output -json github_actions_variables | python3 -c 'import json,sys; [print(f"    {k} = {v}") for k,v in json.load(sys.stdin).items()]'
echo
echo "    Staging URL (live after the first deploy):"
terraform output -json service_urls | python3 -c 'import json,sys; [print(f"    {k}: {v}") for k,v in json.load(sys.stdin).items()]'
