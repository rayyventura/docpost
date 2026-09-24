# -----------------------------------------------------------------------------
# RDS Module — PostgreSQL 16 + RDS Proxy + Per-Service Secrets
# ADR-009: Single instance, 3 logical databases
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "rds"
  }

  service_names = ["auth_service", "platform_service", "docpost_service"]
}

# -----------------------------------------------------------------------------
# DB Subnet Group
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-db-subnet"
  })
}

# -----------------------------------------------------------------------------
# Security Group — RDS Instance
# -----------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name_prefix = "${var.project_name}-${var.environment}-rds-"
  description = "Security group for the RDS PostgreSQL instance"
  vpc_id      = var.vpc_id

  ingress {
    description = "PostgreSQL from VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Master Password — Secrets Manager
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "master_password" {
  name        = "${var.project_name}/${var.environment}/rds/master-password"
  description = "Master password for the ${var.project_name} RDS instance"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "master_password" {
  secret_id     = aws_secretsmanager_secret.master_password.id
  secret_string = var.master_password
}

# -----------------------------------------------------------------------------
# RDS Instance — PostgreSQL 16
# -----------------------------------------------------------------------------
resource "aws_db_instance" "main" {
  identifier = "${var.project_name}-${var.environment}-postgres"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.master_username
  password = var.master_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = var.multi_az
  publicly_accessible = false

  backup_retention_period = var.backup_retention_period
  skip_final_snapshot     = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.project_name}-${var.environment}-final-snapshot"

  performance_insights_enabled = false

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-postgres"
  })
}

# -----------------------------------------------------------------------------
# Per-Service Secrets (placeholder values — actual creds set by db-bootstrap)
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "service_credentials" {
  for_each = toset(local.service_names)

  name        = "${var.project_name}/${var.environment}/rds/${each.key}"
  description = "Database credentials for ${each.key}"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "service_credentials" {
  for_each = toset(local.service_names)

  secret_id = aws_secretsmanager_secret.service_credentials[each.key].id
  secret_string = jsonencode({
    username = each.key
    password = "PLACEHOLDER_SET_BY_BOOTSTRAP"
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = each.key
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# -----------------------------------------------------------------------------
# Security Group — RDS Proxy
# -----------------------------------------------------------------------------
resource "aws_security_group" "rds_proxy" {
  name_prefix = "${var.project_name}-${var.environment}-rds-proxy-"
  description = "Security group for RDS Proxy"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from ECS and Lambda"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.client_security_group_ids
  }

  egress {
    description     = "PostgreSQL to RDS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.rds.id]
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-rds-proxy-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# IAM Role for RDS Proxy — Secrets Manager Access
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_iam_role" "rds_proxy" {
  name = "${var.project_name}-${var.environment}-rds-proxy-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "rds.amazonaws.com"
        }
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  name = "${var.project_name}-${var.environment}-rds-proxy-secrets"
  role = aws_iam_role.rds_proxy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:GetResourcePolicy",
          "secretsmanager:DescribeSecret",
          "secretsmanager:ListSecretVersionIds"
        ]
        Resource = concat(
          [aws_secretsmanager_secret.master_password.arn],
          [for s in aws_secretsmanager_secret.service_credentials : s.arn]
        )
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# RDS Proxy
# -----------------------------------------------------------------------------
resource "aws_db_proxy" "main" {
  name                   = "${var.project_name}-${var.environment}-proxy"
  debug_logging          = false
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_security_group_ids = [aws_security_group.rds_proxy.id]
  vpc_subnet_ids         = var.private_subnet_ids

  auth {
    auth_scheme = "SECRETS"
    description = "Master credentials"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_secretsmanager_secret.master_password.arn
  }

  dynamic "auth" {
    for_each = toset(local.service_names)
    content {
      auth_scheme = "SECRETS"
      description = "${auth.key} credentials"
      iam_auth    = "REQUIRED"
      secret_arn  = aws_secretsmanager_secret.service_credentials[auth.key].arn
    }
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-rds-proxy"
  })
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    max_connections_percent      = 100
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = aws_db_instance.main.identifier
}
