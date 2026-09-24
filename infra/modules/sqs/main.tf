# -----------------------------------------------------------------------------
# SQS Module — Queue Pairs (queue + DLQ) for Upload Events, Jobs, Tasks
# ADR-005, ADR-008: Standard queues with DLQs
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "sqs"
  }

  queue_configs = {
    upload-events = {
      visibility_timeout = 60
    }
    jobs = {
      visibility_timeout = 60
    }
    tasks = {
      visibility_timeout = 360 # 6x Lambda timeout
    }
  }
}

# -----------------------------------------------------------------------------
# Dead Letter Queues
# -----------------------------------------------------------------------------
resource "aws_sqs_queue" "dlq" {
  for_each = local.queue_configs

  name                      = "${var.project_name}-${var.environment}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = merge(local.common_tags, {
    Name    = "${var.project_name}-${var.environment}-${each.key}-dlq"
    Purpose = "dead-letter-queue"
  })
}

# -----------------------------------------------------------------------------
# Main Queues
# -----------------------------------------------------------------------------
resource "aws_sqs_queue" "main" {
  for_each = local.queue_configs

  name                       = "${var.project_name}-${var.environment}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout
  message_retention_seconds  = 1209600 # 14 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-${each.key}"
  })
}

# -----------------------------------------------------------------------------
# SQS Queue Policy — Allow S3 to send messages to upload-events queue
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

resource "aws_sqs_queue_policy" "upload_events" {
  queue_url = aws_sqs_queue.main["upload-events"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowS3Notification"
        Effect    = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.main["upload-events"].arn
        Condition = {
          ArnLike = {
            "aws:SourceArn" = var.staging_bucket_arn
          }
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# S3 Bucket Notification — ObjectCreated → upload-events queue
# -----------------------------------------------------------------------------
resource "aws_s3_bucket_notification" "staging" {
  bucket = var.staging_bucket_name

  queue {
    queue_arn = aws_sqs_queue.main["upload-events"].arn
    events    = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_sqs_queue_policy.upload_events]
}
