variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "service_names" {
  description = "List of service names to create ECR repositories for."
  type        = list(string)
  default     = ["auth", "platform", "docpost-api"]
}

variable "max_image_count" {
  description = "Maximum number of images to keep per repository."
  type        = number
  default     = 10
}
