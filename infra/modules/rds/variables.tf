variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC where RDS resources will be created."
  type        = string
}

variable "vpc_cidr_block" {
  description = "CIDR block of the VPC, used for security group ingress rules."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the DB subnet group and RDS Proxy."
  type        = list(string)
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Allocated storage in GB for the RDS instance."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Maximum storage in GB for autoscaling. Set to 0 to disable."
  type        = number
  default     = 50
}

variable "db_name" {
  description = "Name of the default database created on the instance."
  type        = string
  default     = "docpost"
}

variable "master_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "docpost_admin"
}

variable "master_password" {
  description = "Master password for the RDS instance. Use a strong, generated value."
  type        = string
  sensitive   = true
}

variable "multi_az" {
  description = "Enable Multi-AZ deployment for high availability."
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Number of days to retain automated backups."
  type        = number
  default     = 7
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final snapshot when the instance is deleted."
  type        = bool
  default     = true
}

variable "enable_proxy" {
  description = "Create an RDS Proxy. Free-plan AWS accounts cannot create one."
  type        = bool
  default     = true
}

variable "client_security_group_ids" {
  description = "Security group IDs for ECS services and Lambda functions that connect via RDS Proxy."
  type        = list(string)
  default     = []
}
