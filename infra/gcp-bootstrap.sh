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

# Enabled here (not only in Terraform) so they have propagated before Terraform creates resources;
# keep in step with infra/terraform/apis.tf.
echo "==> Enabling APIs (first run can take a minute or two)"
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com run.googleapis.com artifactregistry.googleapis.com compute.googleapis.com \
  logging.googleapis.com monitoring.googleapis.com

echo "==> Terraform state bucket gs://${STATE_BUCKET}"
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${STATE_BUCKET}" --location="${REGION}" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi

# Cloud Shell no longer ships Terraform (its `terraform` is a stub that prints install hints and
# exits 0). Install a pinned binary into ~/bin, which persists across Cloud Shell sessions.
TF_VERSION="1.9.8"
TF="${HOME}/bin/terraform"
if ! "${TF}" version 2>/dev/null | grep -q "^Terraform v${TF_VERSION}"; then
  echo "==> Installing Terraform ${TF_VERSION} into ~/bin"
  mkdir -p "${HOME}/bin"
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/tf.zip" \
    "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip"
  curl -fsSL -o "${tmp}/SHA256SUMS" \
    "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_SHA256SUMS"
  (cd "${tmp}" && grep "_linux_amd64.zip" SHA256SUMS | sed "s/terraform_.*_linux_amd64.zip/tf.zip/" | sha256sum -c -)
  unzip -o -q "${tmp}/tf.zip" terraform -d "${HOME}/bin"
  rm -rf "${tmp}"
fi
"${TF}" version | head -1

cd "${TF_DIR}"
if [ ! -f terraform.tfvars ]; then
  sed "s/^project_id = .*/project_id = \"${PROJECT_ID}\"/" terraform.tfvars.example > terraform.tfvars
  echo "==> Wrote ${TF_DIR}/terraform.tfvars (staging only, sample data)"
fi

echo "==> terraform apply"
"${TF}" init -input=false -backend-config="bucket=${STATE_BUCKET}"
"${TF}" apply -input=false

echo "==> Server Functions encryption key (generated here, never printed)"
KEY_SECRET="truenest-next-server-actions-key"
if [ -z "$(gcloud secrets versions list "${KEY_SECRET}" --filter='state=ENABLED' --format='value(name)' --limit=1)" ]; then
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add "${KEY_SECRET}" --data-file=-
fi

echo
echo "==> Done. Add these as GitHub repository VARIABLES (not secrets; none of them is sensitive):"
echo "    https://github.com/vkkumar123/truenestai/settings/variables/actions"
"${TF}" output -json github_actions_variables | python3 -c 'import json,sys; [print(f"    {k} = {v}") for k,v in json.load(sys.stdin).items()]'
echo
echo "    Staging URL (live after the first deploy):"
"${TF}" output -json service_urls | python3 -c 'import json,sys; [print(f"    {k}: {v}") for k,v in json.load(sys.stdin).items()]'
