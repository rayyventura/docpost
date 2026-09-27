variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Invoke ARN of the WebSocket lifecycle Lambda."
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the WebSocket lifecycle Lambda."
  type        = string
}

variable "throttling_burst_limit" {
  description = "Throttling burst limit."
  type        = number
  default     = 200
}

variable "throttling_rate_limit" {
  description = "Throttling rate limit."
  type        = number
  default     = 100
}
