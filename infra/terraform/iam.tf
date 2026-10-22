data "google_project" "this" {}

# ---------------------------------------------------------------------------
# Runtime identity: one per environment, so production secrets are unreadable from staging.
# ---------------------------------------------------------------------------
resource "google_service_account" "runtime" {
  for_each     = var.environments
  account_id   = "truenest-run-${each.key}"
  display_name = "TrueNest Cloud Run runtime (${each.key})"
  depends_on   = [google_project_service.enabled]
}

# ---------------------------------------------------------------------------
# Deployer identity, used only by GitHub Actions through Workload Identity Federation.
# No JSON keys exist anywhere.
# ---------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  account_id   = "truenest-deployer"
  display_name = "TrueNest GitHub Actions deployer"
  depends_on   = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "truenestai"
  display_name                       = "truenestai repo"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.environment"         = "assertion.environment"
  }

  # Only this repo, owned by this account, and only jobs bound to a GitHub deployment
  # environment (staging/production) can get a token. PR jobs never can.
  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.environment in ['staging', 'production']",
  ])
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Push images.
resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploy revisions to the TrueNest services only (not project-wide run.admin).
resource "google_cloud_run_v2_service_iam_member" "deployer_develop" {
  for_each = var.environments
  name     = google_cloud_run_v2_service.app[each.key].name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploying a revision that runs as the runtime SA requires actAs on that SA.
resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  for_each           = var.environments
  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# Read the Server Functions encryption key at build time.
resource "google_secret_manager_secret_iam_member" "deployer_build_key" {
  secret_id = google_secret_manager_secret.build_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deployer.email}"
}
