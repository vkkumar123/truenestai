terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.40"
    }
  }

  # State lives in a GCS bucket the owner creates once (docs/DEPLOYMENT.md, step 3):
  #   terraform init -backend-config="bucket=<project-id>-tfstate"
  backend "gcs" {
    prefix = "truenest"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
