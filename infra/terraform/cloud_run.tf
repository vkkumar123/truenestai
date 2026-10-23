locals {
  behind_lb = { for env, cfg in var.environments : env => cfg.domain != "" }
}

resource "google_cloud_run_v2_service" "app" {
  for_each = var.environments

  name                = "truenest-${each.key}"
  location            = var.region
  deletion_protection = each.key == "production"
  # With a domain, only the load balancer (and so Cloud Armor) can reach the service.
  ingress = local.behind_lb[each.key] ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.runtime[each.key].email
    max_instance_request_concurrency = 80
    # Research jobs triggered by Cloud Scheduler can take ~120 s.
    timeout = "300s"

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    containers {
      image = var.bootstrap_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "DATA_BACKEND"
        value = each.value.data_backend
      }
      # Client IP = this many X-Forwarded-For entries from the right. Cloud Run appends the
      # caller's IP; a Google load balancer appends its own after that.
      env {
        name  = "TRUSTED_PROXY_HOPS"
        value = local.behind_lb[each.key] ? "2" : "1"
      }

      dynamic "env" {
        for_each = each.value.secrets_ready ? {
          for k, s in local.env_secrets : s.var_name => s.secret_id
          if s.env == each.key && (!s.research || each.value.research_ready)
        } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/"
        }
        period_seconds    = 5
        failure_threshold = 12
      }
    }
  }

  # CI deploys new images; Terraform owns everything else.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      template[0].labels,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.enabled, google_secret_manager_secret_iam_member.runtime_access]
}

# Public website: anyone may invoke. Ingress (above) still limits which network path is allowed.
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = var.environments
  name     = google_cloud_run_v2_service.app[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
