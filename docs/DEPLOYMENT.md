# Deployment: Google Cloud Run

Decision: app on **Cloud Run (asia-south1, Mumbai)**, data on **Supabase (ap-south-1, Mumbai)**, chosen by the owner on 2026-10-21 (see `DECISIONS.md`, "GCP hosting"). Owner actions are tracked in `MCP_REQUESTS.md` R7.

## What runs where
| Piece | Where | Managed by |
|---|---|---|
| Container image | Artifact Registry `asia-south1-docker.pkg.dev/<project>/truenest/web` | GitHub Actions (`.github/workflows/deploy.yml`) |
| Web app | Cloud Run service `truenest-<env>` | Terraform (config) + Actions (image) |
| Runtime secrets | Secret Manager `truenest-<env>-supabase-*` | Terraform creates the secret; the owner adds values |
| Build secret | Secret Manager `truenest-next-server-actions-key` | `infra/gcp-bootstrap.sh` generates it |
| Deploy identity | Service account `truenest-deployer`, reached only via Workload Identity Federation from this repo's `staging`/`production` GitHub environments | Terraform |
| Custom domain (optional) | Global HTTPS load balancer + Google-managed certificate + Cloud Armor | Terraform, when `domain` is set |
| Database, staff auth, documents | Supabase | M2 |

No service-account keys exist. Nothing secret is stored in GitHub or Terraform state.

## One-time setup (owner, Google Cloud Shell)
1. Open Cloud Shell in project `truenestai`: https://console.cloud.google.com/?project=truenestai&cloudshell=true
2. Run:
   ```bash
   git clone -b infra/gcp-cloud-run https://github.com/vkkumar123/truenestai.git
   cd truenestai && bash infra/gcp-bootstrap.sh
   ```
   It checks billing, creates the Terraform state bucket, applies `infra/terraform` (type `yes` at the prompt), generates the build key, and prints five values.
3. Add those five as **repository variables** at https://github.com/vkkumar123/truenestai/settings/variables/actions: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_ARTIFACT_REPOSITORY`.
4. Deploy: push to `main`, or push any commit to the `staging` branch (`git push origin HEAD:staging`), or run the workflow manually from the Actions tab.

## Switching staging to Supabase (after M2)
In fixture mode the hosted site shows SAMPLE data only, keeps leads in one instance's memory, and refuses staff sign-in (the dev password login is disabled whenever `NODE_ENV=production`). Real buyer + admin testing needs Supabase:
1. Add each value in Cloud Shell without it touching chat or shell history:
   ```bash
   for s in supabase-url supabase-anon-key supabase-service-role-key; do
     read -rsp "truenest-staging-$s: " v; echo
     printf %s "$v" | gcloud secrets versions add "truenest-staging-$s" --data-file=-
   done
   ```
   (The secrets exist only after `data_backend = "supabase"` is applied, so do step 2 first with `secrets_ready = false`, then this, then step 3.)
2. In `infra/terraform/terraform.tfvars` set `data_backend = "supabase"` for staging and run `~/bin/terraform apply` (from `infra/terraform`).
3. Set `secrets_ready = true` and run `~/bin/terraform apply` (from `infra/terraform`) again. Cloud Run rolls a new revision with the secrets.

## Production
Add a `production` entry with a `domain` (see `terraform.tfvars.example`), apply, then point the domain's A record at the `dns_records` output. The certificate provisions once DNS resolves (up to ~60 minutes). In GitHub, add required reviewers to the `production` environment and set the `PRODUCTION_URL` variable. Promote with Actions → Deploy → Run workflow → `production`: it reuses the image built and smoke-tested on staging for that commit, smoke-tests through the domain, and rolls traffic back to the previous revision if that fails.

With a domain, the service accepts traffic only from the load balancer, so Cloud Armor applies: a per-IP POST throttle (`lead_rate_limit_per_minute`) and OWASP XSS/SQLi rules. `TRUSTED_PROXY_HOPS` is set to 2 there (Cloud Run appends the client IP, the load balancer appends its own) and to 1 on plain `*.run.app`.

## Operational notes
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is a BuildKit secret: Next embeds it in the build, so every instance and the promoted production image agree on it. Rotating it means rebuilding.
- `deploymentId` is the git SHA, so clients on an old revision hard-reload instead of calling missing Server Functions.
- The Next.js cache is per instance (no shared cache handler yet). With the current `'use cache'` use (a banner, hours-long) that is acceptable; add a shared handler before relying on `revalidateTag` across instances.
- The lead rate limiter in the app is still per instance; Cloud Armor is the shared limit in production.
- Rollback by hand: `gcloud run services update-traffic truenest-<env> --to-revisions=<revision>=100 --region=asia-south1`.
- Approximate cost: staging with `min_instances = 0` is near zero at test traffic; production with `min_instances = 1` plus the load balancer is roughly US$30–45/month before traffic.
