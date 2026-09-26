variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
  default     = "docpost"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region to deploy resources into."
  type        = string
  default     = "us-east-1"
}

# -- SPA / CORS ----------------------------------------------------------------

variable "spa_cors_origins" {
  description = "Allowed origins for CORS on the API Gateway."
  type        = list(string)
  default     = ["*"]
}

# -- Secrets -------------------------------------------------------------------

variable "secret_recovery_window_days" {
  description = "Days Secrets Manager keeps a deleted secret recoverable. 0 deletes immediately so the same name can be recreated right after a destroy."
  type        = number
  default     = 0
}
