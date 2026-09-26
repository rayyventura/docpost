variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "create_api" {
  description = "Create the HTTP API and its default stage. Set false to attach routes to an API owned by another stack (see api_id)."
  type        = bool
  default     = true
}

variable "api_id" {
  description = "ID of an existing HTTP API. Required when create_api is false."
  type        = string
  default     = null
}

variable "create_alb_integration" {
  description = "Create the VPC Link, ALB integration, JWT authorizer, and routes. Set false for a stack that only owns the API itself."
  type        = bool
  default     = true
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the VPC Link. Required when create_alb_integration is true."
  type        = list(string)
  default     = []
}

variable "vpc_link_security_group_ids" {
  description = "Security group IDs for the VPC Link. Required when create_alb_integration is true."
  type        = list(string)
  default     = []
}

variable "alb_listener_arn" {
  description = "ARN of the ALB listener to integrate with. Required when create_alb_integration is true."
  type        = string
  default     = null
}

variable "cors_allow_origins" {
  description = "Allowed origins for CORS."
  type        = list(string)
  default     = ["*"]
}

variable "cors_allow_methods" {
  description = "Allowed HTTP methods for CORS."
  type        = list(string)
  default     = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
}

variable "cors_allow_headers" {
  description = "Allowed headers for CORS."
  type        = list(string)
  default     = ["Authorization", "Content-Type", "X-Request-Id"]
}

variable "jwt_issuer" {
  description = "JWT issuer URL for the authorizer. Set to null to skip authorizer creation."
  type        = string
  default     = null
}

variable "jwt_audience" {
  description = "JWT audience values for the authorizer."
  type        = list(string)
  default     = []
}

variable "throttling_burst_limit" {
  description = "Throttling burst limit (requests per second)."
  type        = number
  default     = 1000
}

variable "throttling_rate_limit" {
  description = "Throttling rate limit (requests per second)."
  type        = number
  default     = 500
}

variable "routes" {
  description = "List of API routes to configure."
  type = list(object({
    route_key    = string
    require_auth = bool
  }))
  default = []
}
