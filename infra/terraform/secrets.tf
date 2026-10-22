# Terraform creates the secret containers and access grants only. Values are added by the owner
# with `gcloud secrets versions add` (docs/DEPLOYMENT.md) so they never enter Terraform state or Git.

locals {
  # Runtime secrets per data backend: env var name => secret suffix.
  runtime_secrets = {
    fixture = {}
    supabase = {
      SUPABASE_URL              = "supabase-url"
      SUPABASE_ANON_KEY         = "supabase-anon-key"
      SUPABASE_SERVICE_ROLE_KEY = "supabase-service-role-key"
    }
  }

  env_secrets = merge([
    for env, cfg in var.environments : {
      for var_name, suffix in local.runtime_secrets[cfg.data_backend] :
      "${env}/${var_name}" => { env = env, var_name = var_name, secret_id = "truenest-${env}-${suffix}" }
    }
  ]...)
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.env_secrets
  secret_id = each.value.secret_id
  labels    = { app = "truenest", env = each.value.env }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each  = local.env_secrets
  secret_id = google_secret_manager_secret.runtime[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.env].email}"
}

# NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: base64 of 32 random bytes. Next embeds it in the build, so
# every instance of an image shares it and the image can be promoted from staging to production.
resource "google_secret_manager_secret" "build_key" {
  secret_id = "truenest-next-server-actions-key"
  labels    = { app = "truenest" }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}
