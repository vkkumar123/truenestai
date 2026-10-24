#!/usr/bin/env bash
# Store the P1/P2 integration keys in Secret Manager for one environment and wire them into Cloud Run.
# Usage (Cloud Shell): bash infra/gcp-enable-integrations.sh staging
# Prompts for each key without echoing; skips keys that already have a version (REPLACE=1 to overwrite).
set -euo pipefail
ENV_NAME="${1:-staging}"; PROJECT_ID="${PROJECT_ID:-truenestai}"; REGION="${REGION:-asia-south1}"
gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable secretmanager.googleapis.com cloudtasks.googleapis.com \
  geocoding-backend.googleapis.com routes.googleapis.com youtube.googleapis.com >/dev/null
has_version() { [ -n "$(gcloud secrets versions list "$1" --filter='state=ENABLED' --format='value(name)' --limit=1 2>/dev/null)" ]; }
ensure_secret() { gcloud secrets describe "$1" >/dev/null 2>&1 || gcloud secrets create "$1" --replication-policy=automatic >/dev/null; }
ask() { # name label
  local s="truenest-${ENV_NAME}-$1"; ensure_secret "$s"
  if has_version "$s" && [ "${REPLACE:-0}" != 1 ]; then echo "   $s already set"; return; fi
  read -rsp "$2 (input hidden, blank to skip): " v; echo
  [ -n "$v" ] || { echo "   skipped $s"; return; }
  printf %s "$v" | gcloud secrets versions add "$s" --data-file=- >/dev/null; unset v; echo "   saved $s"
}
echo "==> Secrets for ${ENV_NAME}"
ask brave-api-key        "Brave Search API key"
ask google-maps-api-key  "Google Maps Platform server key (Geocoding + Routes API)"
ask reddit-client-id     "Reddit client id"
ask reddit-client-secret "Reddit client secret"
ask youtube-api-key      "YouTube Data API key"
echo "==> Cloud Tasks queue"
gcloud tasks queues describe truenest-research --location="${REGION}" >/dev/null 2>&1 || \
  gcloud tasks queues create truenest-research --location="${REGION}" --max-dispatches-per-second=1 --max-concurrent-dispatches=3 >/dev/null
echo "==> Wiring secrets into Cloud Run (only secrets that have a value; names only)"
SA="truenest-run-${ENV_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
declare -A VAR=( [brave-api-key]=BRAVE_API_KEY [google-maps-api-key]=GOOGLE_MAPS_API_KEY [reddit-client-id]=REDDIT_CLIENT_ID [reddit-client-secret]=REDDIT_CLIENT_SECRET [youtube-api-key]=YOUTUBE_API_KEY )
mounts=()
for s in "${!VAR[@]}"; do
  full="truenest-${ENV_NAME}-${s}"
  if has_version "$full"; then
    gcloud secrets add-iam-policy-binding "$full" --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor >/dev/null 2>&1 || true
    mounts+=("${VAR[$s]}=${full}:latest")
  else
    echo "   ${VAR[$s]}: no value stored yet, not mounted"
  fi
done
if [ "${#mounts[@]}" -gt 0 ]; then
  IFS=, ; gcloud run services update "truenest-${ENV_NAME}" --region="${REGION}" --update-secrets="${mounts[*]}" >/dev/null; unset IFS
  echo "   mounted: ${mounts[*]%%=*}"
else
  echo "   nothing to mount"
fi
gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA}" --role=roles/cloudtasks.enqueuer --condition=None >/dev/null
echo "==> Done. Add the same names to Terraform env_secrets when you next apply (infra/terraform/secrets.tf)."
