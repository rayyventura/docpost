variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC where the ALB is deployed."
  type        = string
}

variable "vpc_cidr_block" {
  description = "CIDR block of the VPC, used for security group ingress."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the internal ALB."
  type        = list(string)
}

variable "services" {
  description = "List of services for target group and routing configuration."
  type = list(object({
    name              = string
    port              = number
    health_check_path = string
    path_patterns     = list(string)
    priority          = number
  }))
  default = []
}
