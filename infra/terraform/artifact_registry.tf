resource "google_artifact_registry_repository" "app" {
  repository_id = "truenest"
  location      = var.region
  format        = "DOCKER"
  description   = "TrueNest web app images (pushed by GitHub Actions)."

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days; the 20 most recent are kept regardless
    }
  }

  depends_on = [google_project_service.enabled]
}
