output "github_actions_variables" {
  description = "Set these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables)."
  value = {
    GCP_PROJECT_ID          = var.project_id
    GCP_REGION              = var.region
    GCP_WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA         = google_service_account.deployer.email
    GCP_ARTIFACT_REPOSITORY = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}"
  }
}

output "service_urls" {
  description = "Cloud Run URLs (reachable directly only for environments without a domain)."
  value       = { for env, svc in google_cloud_run_v2_service.app : env => svc.uri }
}

output "dns_records" {
  description = "Create an A record for each domain pointing at this IP. The managed certificate provisions after DNS resolves (up to ~60 min)."
  value       = { for env, cfg in local.lb_envs : cfg.domain => google_compute_global_address.lb[env].address }
}
