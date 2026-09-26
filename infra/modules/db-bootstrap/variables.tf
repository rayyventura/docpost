variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "region" {
  description = "AWS region for CloudWatch log group configuration."
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "ID of the VPC the task runs in. It must be able to reach the RDS instance."
  type        = string
}

variable "db_host" {
  description = "Hostname of the RDS instance."
  type        = string
}

variable "db_port" {
  description = "Port of the RDS instance."
  type        = number
  default     = 5432
}

variable "master_username" {
  description = "Master username of the RDS instance."
  type        = string
}

variable "master_secret_arn" {
  description = "ARN of the secret holding the master password (plain string)."
  type        = string
}

variable "service_secret_arns" {
  description = "Map of database role name (auth_service, ...) to the ARN of the secret holding that service's DATABASE_URL."
  type        = map(string)
}

variable "image" {
  description = "Image with bash and psql. The default is the official Postgres image, pulled through the NAT gateway."
  type        = string
  default     = "public.ecr.aws/docker/library/postgres:16"
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch log events."
  type        = number
  default     = 30
}
