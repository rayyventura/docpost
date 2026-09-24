# -----------------------------------------------------------------------------
# Lambda Module — Generic Lambda Function with Optional SQS Trigger
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "lambda"
    Function    = var.function_name
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "function" {
  name              = "/aws/lambda/${var.project_name}-${var.environment}-${var.function_name}"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# IAM Execution Role
# -----------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  name = "${var.project_name}-${var.environment}-${var.function_name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = local.common_tags
}

# CloudWatch Logs permission
resource "aws_iam_role_policy" "logs" {
  name = "${var.project_name}-${var.environment}-${var.function_name}-logs"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.function.arn}:*"
      }
    ]
  })
}

# VPC access permission (if VPC-connected)
resource "aws_iam_role_policy_attachment" "vpc_access" {
  count = var.vpc_config != null ? 1 : 0

  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# SQS permission (if event source mapping is configured)
resource "aws_iam_role_policy" "sqs" {
  count = var.sqs_event_source != null ? 1 : 0

  name = "${var.project_name}-${var.environment}-${var.function_name}-sqs"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = var.sqs_event_source.queue_arn
      }
    ]
  })
}

# Additional configurable policy attachments
resource "aws_iam_role_policy_attachment" "additional" {
  for_each = toset(var.policy_arns)

  role       = aws_iam_role.execution.name
  policy_arn = each.value
}

# -----------------------------------------------------------------------------
# Lambda Function
# -----------------------------------------------------------------------------
resource "aws_lambda_function" "function" {
  function_name = "${var.project_name}-${var.environment}-${var.function_name}"
  role          = aws_iam_role.execution.arn

  runtime     = var.runtime
  handler     = var.handler
  memory_size = var.memory_size
  timeout     = var.timeout

  # Placeholder — actual deployment package is set by CI/CD
  filename         = var.filename
  source_code_hash = var.source_code_hash

  environment {
    variables = var.environment_variables
  }

  dynamic "vpc_config" {
    for_each = var.vpc_config != null ? [var.vpc_config] : []
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_target_arn != null ? [var.dead_letter_target_arn] : []
    content {
      target_arn = dead_letter_config.value
    }
  }

  reserved_concurrent_executions = var.reserved_concurrent_executions

  depends_on = [
    aws_cloudwatch_log_group.function,
    aws_iam_role_policy.logs,
  ]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# SQS Event Source Mapping (optional)
# -----------------------------------------------------------------------------
resource "aws_lambda_event_source_mapping" "sqs" {
  count = var.sqs_event_source != null ? 1 : 0

  event_source_arn                   = var.sqs_event_source.queue_arn
  function_name                      = aws_lambda_function.function.arn
  batch_size                         = var.sqs_event_source.batch_size
  maximum_batching_window_in_seconds = var.sqs_event_source.batching_window_seconds

  function_response_types = ["ReportBatchItemFailures"]
}
