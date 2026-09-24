variable "project_name" {
  description = "Project name used as a prefix for all bootstrap resources."
  type        = string
  default     = "docpost"
}

variable "region" {
  description = "AWS region for the state backend resources."
  type        = string
  default     = "us-east-1"
}
