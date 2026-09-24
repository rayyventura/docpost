variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "staging_bucket_name" {
  description = "Name of the S3 bucket for staging uploaded files."
  type        = string
}

variable "spa_bucket_name" {
  description = "Name of the S3 bucket for SPA static hosting."
  type        = string
}

variable "cors_allowed_origins" {
  description = "List of allowed origins for CORS on the staging bucket."
  type        = list(string)
  default     = ["*"]
}
