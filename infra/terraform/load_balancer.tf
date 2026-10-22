# Global external HTTPS load balancer for environments with a custom domain. Cloud Run domain
# mappings are not offered in asia-south1, and the load balancer also gives us Cloud Armor
# (edge rate limiting + OWASP rules) and a stable IP for the DNS A record.

locals {
  lb_envs = { for env, cfg in var.environments : env => cfg if cfg.domain != "" }
}

resource "google_compute_global_address" "lb" {
  for_each   = local.lb_envs
  name       = "truenest-${each.key}-ip"
  depends_on = [google_project_service.enabled]
}

resource "google_compute_region_network_endpoint_group" "run" {
  for_each              = local.lb_envs
  name                  = "truenest-${each.key}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.app[each.key].name
  }
}

resource "google_compute_security_policy" "edge" {
  for_each = local.lb_envs
  name     = "truenest-${each.key}-edge"

  # Per-IP throttle on POSTs (lead form submissions run as Server Function POSTs).
  rule {
    priority = 1000
    action   = "throttle"
    match {
      expr {
        expression = "request.method == 'POST'"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.lead_rate_limit_per_minute
        interval_sec = 60
      }
    }
    description = "Throttle POSTs per client IP"
  }

  rule {
    priority = 2000
    action   = "deny(403)"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1}) || evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "OWASP XSS / SQLi (sensitivity 1)"
  }

  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }
}

resource "google_compute_backend_service" "run" {
  for_each              = local.lb_envs
  name                  = "truenest-${each.key}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge[each.key].id

  backend {
    group = google_compute_region_network_endpoint_group.run[each.key].id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "https" {
  for_each        = local.lb_envs
  name            = "truenest-${each.key}-https"
  default_service = google_compute_backend_service.run[each.key].id
}

resource "google_compute_managed_ssl_certificate" "cert" {
  for_each = local.lb_envs
  name     = "truenest-${each.key}-cert"
  managed {
    domains = [each.value.domain]
  }
}

resource "google_compute_target_https_proxy" "https" {
  for_each         = local.lb_envs
  name             = "truenest-${each.key}-https-proxy"
  url_map          = google_compute_url_map.https[each.key].id
  ssl_certificates = [google_compute_managed_ssl_certificate.cert[each.key].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  for_each              = local.lb_envs
  name                  = "truenest-${each.key}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[each.key].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.https[each.key].id
}

# Plain HTTP only redirects to HTTPS.
resource "google_compute_url_map" "http_redirect" {
  for_each = local.lb_envs
  name     = "truenest-${each.key}-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http" {
  for_each = local.lb_envs
  name     = "truenest-${each.key}-http-proxy"
  url_map  = google_compute_url_map.http_redirect[each.key].id
}

resource "google_compute_global_forwarding_rule" "http" {
  for_each              = local.lb_envs
  name                  = "truenest-${each.key}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[each.key].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.http[each.key].id
}
