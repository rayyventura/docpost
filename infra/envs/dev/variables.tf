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

# -- Network ------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

# -- RDS ----------------------------------------------------------------------

variable "rds_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "rds_master_password" {
  description = "Master password for the RDS instance."
  type        = string
  sensitive   = true
}

# -- ECS ----------------------------------------------------------------------

variable "ecs_cpu" {
  description = "CPU units for ECS Fargate tasks."
  type        = number
  default     = 256
}

variable "ecs_memory" {
  description = "Memory in MiB for ECS Fargate tasks."
  type        = number
  default     = 512
}

variable "ecs_desired_count" {
  description = "Desired number of ECS tasks per service."
  type        = number
  default     = 1
}

# -- SPA / CORS ----------------------------------------------------------------

variable "spa_cors_origins" {
  description = "Allowed origins for CORS on the staging bucket and API Gateway."
  type        = list(string)
  default     = ["*"]
}
