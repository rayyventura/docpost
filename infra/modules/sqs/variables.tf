variable "project_name" {
  description = "Project name used for resource naming and tagging."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, prod)."
  type        = string
}

variable "max_receive_count" {
  description = "Number of times a message can be received before being sent to the DLQ."
  type        = number
  default     = 3
}

variable "staging_bucket_name" {
  description = "Name of the staging S3 bucket (for S3 event notification)."
  type        = string
}

variable "staging_bucket_arn" {
  description = "ARN of the staging S3 bucket (for SQS queue policy)."
  type        = string
}
