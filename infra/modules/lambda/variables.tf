variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "function_name" {
  description = "Short name for the Lambda function (e.g. fanout, delivery, watchdog)."
  type        = string
}

variable "runtime" {
  description = "Lambda runtime identifier."
  type        = string
  default     = "nodejs22.x"
}

variable "handler" {
  description = "Function handler entry point (e.g. index.handler)."
  type        = string
}

variable "memory_size" {
  description = "Amount of memory in MB for the Lambda function."
  type        = number
  default     = 256
}

variable "timeout" {
  description = "Function timeout in seconds."
  type        = number
  default     = 60
}

variable "filename" {
  description = "Path to the deployment package zip file."
  type        = string
  default     = null
}

variable "source_code_hash" {
  description = "Hash of the deployment package for change detection."
  type        = string
  default     = null
}

variable "environment_variables" {
  description = "Map of environment variable names to values."
  type        = map(string)
  default     = {}
}

variable "vpc_config" {
  description = "VPC configuration for the Lambda function. Set to null for non-VPC functions."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "dead_letter_target_arn" {
  description = "ARN of an SQS queue or SNS topic for dead letter delivery. Set to null to disable."
  type        = string
  default     = null
}

variable "reserved_concurrent_executions" {
  description = "Number of reserved concurrent executions. Set to -1 for unreserved."
  type        = number
  default     = -1
}

variable "sqs_event_source" {
  description = "SQS event source mapping configuration. Set to null to disable."
  type = object({
    queue_arn               = string
    batch_size              = number
    batching_window_seconds = number
  })
  default = null
}

variable "policy_arns" {
  description = "List of additional IAM policy ARNs to attach to the execution role."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch log events."
  type        = number
  default     = 30
}
