variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "spa_bucket_name" {
  description = "Name of the S3 bucket hosting the SPA."
  type        = string
}

variable "spa_bucket_arn" {
  description = "ARN of the S3 bucket hosting the SPA."
  type        = string
}

variable "spa_bucket_regional_domain_name" {
  description = "Regional domain name of the SPA S3 bucket."
  type        = string
}
