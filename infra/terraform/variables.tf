variable "project_id" {
  description = "GCP project ID that hosts TrueNest."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and secrets. Mumbai keeps latency low and sits next to Supabase ap-south-1."
  type        = string
  default     = "asia-south1"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "vkkumar123/truenestai"
}

variable "github_repository_owner_id" {
  description = "Numeric GitHub ID of the repository owner. Pinned so a renamed or re-registered account cannot reuse the trust."
  type        = string
  default     = "35333263"
}

variable "bootstrap_image" {
  description = "Placeholder image for the first apply, before CI has pushed a real one. CI owns the image afterwards."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "environments" {
  description = <<-EOT
    One Cloud Run service per environment.
    data_backend: "fixture" (SAMPLE data, no secrets) or "supabase" (needs the supabase-* secrets populated).
    domain: empty = public *.run.app URL only; set = global HTTPS load balancer + managed cert + Cloud Armor,
    and the service only accepts traffic from the load balancer.
    Production in supabase mode only goes live after M2 (Supabase persistence + Auth) is merged.
  EOT
  type = map(object({
    data_backend  = string
    min_instances = number
    max_instances = number
    domain        = optional(string, "")
    # Set true once the environment's secrets have values (docs/DEPLOYMENT.md, step 5). Until then
    # the service is not wired to them, because Cloud Run refuses a secret that has no version.
    secrets_ready = optional(bool, false)
    # Set true once anthropic-api-key and research-run-secret have values (infra/gcp-enable-research.sh).
    research_ready = optional(bool, false)
  }))
  # Staging only until production is wanted; add a production entry in terraform.tfvars.
  default = {
    staging = {
      data_backend  = "fixture"
      min_instances = 0
      max_instances = 2
    }
  }

  validation {
    condition     = alltrue([for e in values(var.environments) : contains(["fixture", "supabase"], e.data_backend)])
    error_message = "data_backend must be \"fixture\" or \"supabase\"."
  }
}

variable "lead_rate_limit_per_minute" {
  description = "Cloud Armor per-IP limit on POST requests (lead form) at the load balancer. The app's own limiter is per instance only."
  type        = number
  default     = 10
}
