variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "staging_bucket_name" {
  description = "Name of the S3 bucket for staging uploaded files. Required when create_staging_bucket is true."
  type        = string
  default     = null
}

variable "spa_bucket_name" {
  description = "Name of the S3 bucket for SPA static hosting. Required when create_spa_bucket is true."
  type        = string
  default     = null
}

variable "create_staging_bucket" {
  description = "Create the staging bucket and its settings. Set false where another stack owns it."
  type        = bool
  default     = true
}

variable "create_spa_bucket" {
  description = "Create the SPA hosting bucket and its settings. Set false where another stack owns it."
  type        = bool
  default     = true
}

variable "staging_force_destroy" {
  description = "Let destroy delete the staging bucket even when it still holds objects. Only for environments that are torn down routinely."
  type        = bool
  default     = false
}

variable "cors_allowed_origins" {
  description = "List of allowed origins for CORS on the staging bucket."
  type        = list(string)
  default     = ["*"]
}
