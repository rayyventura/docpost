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

variable "service_name" {
  description = "Name of the ECS service (e.g. auth, platform, docpost-api)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC where the ECS service runs."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the ECS tasks."
  type        = list(string)
}

variable "cluster_arn" {
  description = "ARN of an existing ECS cluster. If null, a new cluster is created."
  type        = string
  default     = null
}

variable "container_image" {
  description = "Docker image URI for the container (e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/docpost/auth:latest)."
  type        = string
}

variable "container_port" {
  description = "Port that the container listens on."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "CPU units for the Fargate task (256, 512, 1024, 2048, 4096)."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory in MiB for the Fargate task."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of running tasks."
  type        = number
  default     = 2
}

variable "environment_variables" {
  description = "Map of environment variable names to values for the container."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret names to Secrets Manager ARNs or SSM Parameter Store ARNs."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "List of Secrets Manager secret ARNs the execution role can read."
  type        = list(string)
  default     = []
}

variable "task_role_policy_arns" {
  description = "List of IAM policy ARNs to attach to the task role."
  type        = list(string)
  default     = []
}

variable "alb_security_group_ids" {
  description = "Security group IDs of the ALB(s) allowed to reach this service."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch log events."
  type        = number
  default     = 30
}
