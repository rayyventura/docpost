# -----------------------------------------------------------------------------
# Dev Base — Root Configuration
#
# The permanent half of dev. Everything here costs close to nothing while idle
# and carries an identity that CI/CD or users depend on (repository URLs, the
# API URL, the CloudFront distribution, the deploy role, secret ARNs).
# infra/envs/dev holds the costly half (VPC, NAT, RDS, ALB, ECS, Lambda, SQS)
# and reads this stack through terraform_remote_state, so dev can be destroyed
# and recreated without any of these values changing.
#
# Apply order: dev-base first, then dev.
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.7"

  # Same backend bucket and lock table as dev, separate key.
  backend "s3" {
    bucket         = "docpost-terraform-state-85db398b" # state_bucket_name
    key            = "dev-base/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "docpost-terraform-lock" # lock_table_name
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  ssm_prefix = "/${var.project_name}/${var.environment}"
}

# =============================================================================
# ECR
# =============================================================================
module "ecr" {
  source = "../../modules/ecr"

  project_name = var.project_name
  environment  = var.environment
}

# =============================================================================
# S3 — SPA hosting bucket only (staging stays in infra/envs/dev)
# =============================================================================
module "s3" {
  source = "../../modules/s3"

  project_name          = var.project_name
  environment           = var.environment
  create_staging_bucket = false
  spa_bucket_name       = "${var.project_name}-${var.environment}-spa"
}

# =============================================================================
# CDN
# =============================================================================
module "cdn" {
  source = "../../modules/cdn"

  project_name                    = var.project_name
  environment                     = var.environment
  spa_bucket_name                 = module.s3.spa_bucket_name
  spa_bucket_arn                  = module.s3.spa_bucket_arn
  spa_bucket_regional_domain_name = module.s3.spa_bucket_regional_domain_name
}

# =============================================================================
# API Gateway — the HTTP API and its stage only
# The VPC link, ALB integration, and routes live in infra/envs/dev.
# =============================================================================
module "api_gateway" {
  source = "../../modules/api-gateway"

  project_name           = var.project_name
  environment            = var.environment
  create_alb_integration = false

  cors_allow_origins = var.spa_cors_origins
}

# =============================================================================
# RDS secrets
# The secret containers are permanent so their ARNs and names stay fixed.
# Their values (versions) are written by infra/envs/dev and by
# scripts/ci-deploy-service.sh.
# =============================================================================
locals {
  rds_service_names = ["auth_service", "platform_service", "docpost_service"]

  rds_secret_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "rds"
  }
}

resource "aws_secretsmanager_secret" "rds_master_password" {
  name        = "${var.project_name}/${var.environment}/rds/master-password"
  description = "Master password for the ${var.project_name} RDS instance"

  recovery_window_in_days = var.secret_recovery_window_days

  tags = local.rds_secret_tags
}

resource "aws_secretsmanager_secret" "rds_service_credentials" {
  for_each = toset(local.rds_service_names)

  name        = "${var.project_name}/${var.environment}/rds/${each.key}"
  description = "Database credentials for ${each.key}"

  recovery_window_in_days = var.secret_recovery_window_days

  tags = local.rds_secret_tags
}

# =============================================================================
# GitHub Actions deploy role (OIDC)
# =============================================================================
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

resource "aws_iam_role" "github_deploy" {
  name = "docpost-dev-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:rayyventura*/docpost*:*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "docpost-dev-github-deploy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = "arn:aws:ecr:${var.region}:*:repository/docpost/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeTasks",
          "ecs:RegisterTaskDefinition",
          "ecs:UpdateService",
          "ecs:RunTask",
          "ecs:ListTasks"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = "arn:aws:secretsmanager:${var.region}:*:secret:docpost/*"
      },
      {
        Effect   = "Allow"
        Action   = ["rds:DescribeDBInstances"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          module.s3.spa_bucket_arn,
          "${module.s3.spa_bucket_arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:CreateLogGroup"
        ]
        Resource = "*"
      },
      {
        # Deploy workflows read environment values from Parameter Store
        # instead of repository secrets and variables.
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.region}:*:parameter${local.ssm_prefix}/*"
      }
    ]
  })
}

# =============================================================================
# SSM Parameter Store — values CI/CD reads
# infra/envs/dev writes the teardown-layer values (cluster, services, ...)
# under the same prefix.
# =============================================================================
resource "aws_ssm_parameter" "api_base" {
  name        = "${local.ssm_prefix}/api_base"
  description = "Base URL of the dev HTTP API (VITE_API_BASE)."
  type        = "String"
  value       = module.api_gateway.api_endpoint
}

resource "aws_ssm_parameter" "cloudfront_distribution_id" {
  name        = "${local.ssm_prefix}/cloudfront_distribution_id"
  description = "CloudFront distribution serving the dev SPA."
  type        = "String"
  value       = module.cdn.distribution_id
}

resource "aws_ssm_parameter" "cdn_domain_name" {
  name        = "${local.ssm_prefix}/cdn_domain_name"
  description = "Domain name of the dev CloudFront distribution."
  type        = "String"
  value       = module.cdn.distribution_domain_name
}

resource "aws_ssm_parameter" "spa_bucket_name" {
  name        = "${local.ssm_prefix}/spa_bucket_name"
  description = "S3 bucket the dev SPA is synced to."
  type        = "String"
  value       = module.s3.spa_bucket_name
}

resource "aws_ssm_parameter" "ecr_repository_url" {
  for_each = module.ecr.repository_urls

  name        = "${local.ssm_prefix}/ecr/${each.key}"
  description = "ECR repository URL for the ${each.key} service."
  type        = "String"
  value       = each.value
}

resource "aws_ssm_parameter" "github_deploy_role_arn" {
  name        = "${local.ssm_prefix}/github_deploy_role_arn"
  description = "IAM role GitHub Actions assumes to deploy dev (AWS_DEPLOY_ROLE_ARN)."
  type        = "String"
  value       = aws_iam_role.github_deploy.arn
}
