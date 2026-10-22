locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "compute.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}
