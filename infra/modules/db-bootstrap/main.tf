# -----------------------------------------------------------------------------
# DB Bootstrap Module — one-off Fargate task that prepares the RDS instance
# ADR-020: runs from the deploy pipeline (scripts/db-bootstrap.sh), never from
# terraform apply.
#
# The task connects as the master user and, for every *_DATABASE_URL it is
# given, makes the database match the URL: the login role exists and has that
# password, and the database exists and is owned by that role. The per-service
# secrets are the source of truth for the passwords; scripts/db-bootstrap.sh
# writes them before it starts the task. Re-running is always safe.
#
# It also provides the security group the pipeline uses for every one-off
# database task (bootstrap, migrations, seed).
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "db-bootstrap"
  }

  name = "${var.project_name}-${var.environment}-db-bootstrap"

  # PGPASSWORD plus auth_service -> AUTH_SERVICE_DATABASE_URL, ...
  container_secrets = merge(
    { PGPASSWORD = var.master_secret_arn },
    { for role, arn in var.service_secret_arns : "${upper(role)}_DATABASE_URL" => arn },
  )

  container_definition = {
    name      = "bootstrap"
    image     = var.image
    essential = true

    command = ["bash", "-c", file("${path.module}/bootstrap.sh")]

    environment = [
      { name = "PGHOST", value = var.db_host },
      { name = "PGPORT", value = tostring(var.db_port) },
      { name = "PGUSER", value = var.master_username },
    ]

    # Sorted by name, the order ECS returns them in, so plans stay clean.
    secrets = [
      for name in sort(keys(local.container_secrets)) : { name = name, valueFrom = local.container_secrets[name] }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.bootstrap.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "bootstrap"
      }
    }
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "bootstrap" {
  name              = "/ecs/${var.project_name}-${var.environment}/db-bootstrap"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# IAM — Execution Role (pull the image, inject the secrets, write logs)
# The container itself never calls AWS, so there is no task role.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  name = "${local.name}-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "${local.name}-exec-secrets"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = concat([var.master_secret_arn], values(var.service_secret_arns))
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Security Group — one-off database tasks
# No ingress. The RDS security group admits the whole VPC CIDR on 5432, and
# the tasks need outbound HTTPS for ECR, Secrets Manager and CloudWatch Logs.
# -----------------------------------------------------------------------------
resource "aws_security_group" "task" {
  name_prefix = "${var.project_name}-${var.environment}-db-task-"
  description = "One-off database tasks (bootstrap, migrations, seed)"
  vpc_id      = var.vpc_id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-db-task-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Task Definition
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "bootstrap" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512

  execution_role_arn = aws_iam_role.execution.arn

  container_definitions = jsonencode([local.container_definition])

  tags = local.common_tags
}
