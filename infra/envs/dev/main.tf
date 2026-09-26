# -----------------------------------------------------------------------------
# Dev Environment — Root Configuration
#
# The teardown layer of dev: VPC, NAT, RDS, ALB, ECS, Lambda, SQS, the staging
# bucket, and the API routes. `terraform destroy` here stops the idle charges.
# The permanent pieces (ECR, SPA bucket + CloudFront, the HTTP API itself, RDS
# secrets, the GitHub deploy role) live in infra/envs/dev-base, which must be
# applied first; this stack reads it through terraform_remote_state below.
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.7"

  # Backend values come from bootstrap output:
  #   cd bootstrap && terraform output
  # Then fill in bucket, dynamodb_table below.
  backend "s3" {
    bucket         = "docpost-terraform-state-85db398b" # state_bucket_name
    key            = "dev/terraform.tfstate"
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

# -----------------------------------------------------------------------------
# Placeholder Lambda deployment package
# Terraform requires a file to exist for aws_lambda_function.
# CI/CD replaces this with real code.
# -----------------------------------------------------------------------------
data "archive_file" "lambda_placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 501, body: 'not deployed' });"
    filename = "index.js"
  }
}

# =============================================================================
# Dev base (permanent layer)
# =============================================================================
data "terraform_remote_state" "base" {
  backend = "s3"

  config = {
    bucket = "docpost-terraform-state-85db398b"
    key    = "dev-base/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  base       = data.terraform_remote_state.base.outputs
  ssm_prefix = "/${var.project_name}/${var.environment}"
}

# =============================================================================
# Network
# =============================================================================
module "network" {
  source = "../../modules/network"

  project_name = var.project_name
  environment  = var.environment
  region       = var.region
  vpc_cidr     = var.vpc_cidr
}

# =============================================================================
# S3 — staging bucket only (the SPA bucket lives in dev-base)
# =============================================================================
module "s3_staging" {
  source = "../../modules/s3"

  project_name          = var.project_name
  environment           = var.environment
  create_spa_bucket     = false
  staging_bucket_name   = "${var.project_name}-${var.environment}-staging"
  staging_force_destroy = true
  cors_allowed_origins  = var.spa_cors_origins
}

# =============================================================================
# SQS
# =============================================================================
module "sqs" {
  source = "../../modules/sqs"

  project_name        = var.project_name
  environment         = var.environment
  staging_bucket_name = module.s3_staging.staging_bucket_name
  staging_bucket_arn  = module.s3_staging.staging_bucket_arn
}

# =============================================================================
# RDS
# =============================================================================
module "rds_instance" {
  source = "../../modules/rds"

  project_name       = var.project_name
  environment        = var.environment
  vpc_id             = module.network.vpc_id
  vpc_cidr_block     = module.network.vpc_cidr_block
  private_subnet_ids = module.network.private_subnet_ids

  instance_class          = var.rds_instance_class
  master_password         = var.rds_master_password
  enable_proxy            = false
  skip_final_snapshot     = true
  multi_az                = false
  backup_retention_period = 1

  # The secrets themselves are permanent (dev-base); this stack writes their values.
  create_secrets      = false
  master_secret_arn   = local.base.rds_master_secret_arn
  service_secret_arns = local.base.rds_service_secret_arns

  client_security_group_ids = [
    module.ecs_auth.security_group_id,
    module.ecs_platform.security_group_id,
    module.ecs_docpost_api.security_group_id,
  ]
}

# =============================================================================
# Database bootstrap (one-off ECS task)
# Creates the service databases and roles to match the per-service secrets.
# Started by scripts/db-bootstrap.sh from CI, never by terraform apply.
# =============================================================================
module "db_bootstrap" {
  source = "../../modules/db-bootstrap"

  project_name = var.project_name
  environment  = var.environment
  region       = var.region
  vpc_id       = module.network.vpc_id

  db_host           = module.rds_instance.db_instance_address
  db_port           = module.rds_instance.db_instance_port
  master_username   = module.rds_instance.master_username
  master_secret_arn = module.rds_instance.master_secret_arn

  service_secret_arns = module.rds_instance.secret_arns
}

# =============================================================================
# ALB
# =============================================================================
module "alb" {
  source = "../../modules/alb"

  project_name       = var.project_name
  environment        = var.environment
  vpc_id             = module.network.vpc_id
  vpc_cidr_block     = module.network.vpc_cidr_block
  private_subnet_ids = module.network.private_subnet_ids

  services = [
    {
      name              = "auth"
      port              = 3000
      health_check_path = "/health"
      path_patterns     = ["/auth/*"]
      priority          = 100
    },
    {
      name              = "platform"
      port              = 3000
      health_check_path = "/health"
      path_patterns     = ["/platform/*"]
      priority          = 200
    },
    {
      name              = "docpost-api"
      port              = 3000
      health_check_path = "/health"
      path_patterns     = ["/api/*"]
      priority          = 300
    },
  ]
}

# =============================================================================
# ECS Services
# =============================================================================
module "ecs_auth" {
  source = "../../modules/ecs-service"

  project_name       = var.project_name
  environment        = var.environment
  region             = var.region
  service_name       = "auth"
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids

  container_image = "${local.base.ecr_repository_urls["auth"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count

  # Images may not be pushed yet right after a spin-up; CI rolls the services.
  wait_for_steady_state = false

  target_group_arn       = module.alb.target_group_arns["auth"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds_instance.secret_arns["auth_service"]]

  secrets = {
    DATABASE_URL = module.rds_instance.secret_arns["auth_service"]
  }

  environment_variables = {
    NODE_ENV     = var.environment
    PORT         = "3000"
    PLATFORM_URL = "http://${module.alb.alb_dns_name}"
  }
}

module "ecs_platform" {
  source = "../../modules/ecs-service"

  project_name       = var.project_name
  environment        = var.environment
  region             = var.region
  service_name       = "platform"
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids

  container_image = "${local.base.ecr_repository_urls["platform"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count

  create_cluster = false
  cluster_arn    = module.ecs_auth.cluster_arn

  # Images may not be pushed yet right after a spin-up; CI rolls the services.
  wait_for_steady_state = false

  target_group_arn       = module.alb.target_group_arns["platform"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds_instance.secret_arns["platform_service"]]

  secrets = {
    DATABASE_URL = module.rds_instance.secret_arns["platform_service"]
  }

  environment_variables = {
    NODE_ENV = var.environment
    PORT     = "3000"
  }
}

module "ecs_docpost_api" {
  source = "../../modules/ecs-service"

  project_name       = var.project_name
  environment        = var.environment
  region             = var.region
  service_name       = "docpost-api"
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids

  container_image = "${local.base.ecr_repository_urls["docpost-api"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count

  create_cluster = false
  cluster_arn    = module.ecs_auth.cluster_arn

  # Images may not be pushed yet right after a spin-up; CI rolls the services.
  wait_for_steady_state = false

  target_group_arn       = module.alb.target_group_arns["docpost-api"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds_instance.secret_arns["docpost_service"]]

  secrets = {
    DATABASE_URL = module.rds_instance.secret_arns["docpost_service"]
  }

  environment_variables = {
    NODE_ENV = var.environment
    PORT     = "3000"
  }
}

# =============================================================================
# API Gateway
# =============================================================================
# The HTTP API and its stage live in dev-base so the URL survives a teardown.
# This stack owns the VPC link, the ALB integration, and the routes.
module "api_routes" {
  source = "../../modules/api-gateway"

  project_name                = var.project_name
  environment                 = var.environment
  create_api                  = false
  api_id                      = local.base.api_id
  private_subnet_ids          = module.network.private_subnet_ids
  vpc_link_security_group_ids = [module.alb.security_group_id]
  alb_listener_arn            = module.alb.listener_arn

  cors_allow_origins = var.spa_cors_origins

  # JWT authorizer — configured after auth service is deployed
  jwt_issuer   = null
  jwt_audience = []

  routes = [
    { route_key = "ANY /auth/{proxy+}", require_auth = false },
    { route_key = "ANY /platform/{proxy+}", require_auth = true },
    { route_key = "ANY /api/{proxy+}", require_auth = true },
  ]
}

# =============================================================================
# Lambda Workers
# =============================================================================
module "lambda_fanout" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "fanout"
  handler       = "handler.handler"
  memory_size   = 256
  timeout       = 60

  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.ecs_auth.security_group_id]
  }

  sqs_event_source = {
    queue_arn               = module.sqs.queue_arns["upload-events"]
    batch_size              = 1
    batching_window_seconds = 0
  }

  environment_variables = {
    NODE_ENV       = var.environment
    S3_BUCKET      = module.s3_staging.staging_bucket_name
    TASK_QUEUE_URL = module.sqs.queue_urls["tasks"]
  }
}

module "lambda_delivery" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "delivery"
  handler       = "handler.handler"
  memory_size   = 256
  timeout       = 60

  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.ecs_auth.security_group_id]
  }

  sqs_event_source = {
    queue_arn               = module.sqs.queue_arns["tasks"]
    batch_size              = 1
    batching_window_seconds = 0
  }

  environment_variables = {
    NODE_ENV       = var.environment
    S3_BUCKET      = module.s3_staging.staging_bucket_name
    PLATFORM_URL   = "http://${module.alb.alb_dns_name}"
    AUTH_TOKEN_URL = "http://${module.alb.alb_dns_name}/auth/token"
  }
}

module "lambda_watchdog" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "watchdog"
  handler       = "handler.handler"
  memory_size   = 128
  timeout       = 60

  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.ecs_auth.security_group_id]
  }

  sqs_event_source = {
    queue_arn               = module.sqs.queue_arns["jobs"]
    batch_size              = 1
    batching_window_seconds = 0
  }

  environment_variables = {
    NODE_ENV       = var.environment
    S3_BUCKET      = module.s3_staging.staging_bucket_name
    TASK_QUEUE_URL = module.sqs.queue_urls["tasks"]
    JOB_QUEUE_URL  = module.sqs.queue_urls["jobs"]
  }
}

module "lambda_ws_lifecycle" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "ws-lifecycle"
  handler       = "handler.handler"
  memory_size   = 128
  timeout       = 30

  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.ecs_auth.security_group_id]
  }

  environment_variables = {
    NODE_ENV = var.environment
  }
}

# =============================================================================
# SSM Parameter Store — teardown-layer values CI/CD reads
# dev-base writes the permanent ones (api_base, ecr/*, spa_bucket_name, ...)
# under the same prefix. These disappear with a teardown, which is how a
# workflow can tell that dev is down.
# =============================================================================
resource "aws_ssm_parameter" "ecs_cluster" {
  name        = "${local.ssm_prefix}/ecs_cluster"
  description = "ECS cluster running the dev services (ECS_CLUSTER)."
  type        = "String"
  value       = element(split("/", module.ecs_auth.cluster_arn), 1)
}

resource "aws_ssm_parameter" "ecs_service" {
  for_each = {
    auth          = module.ecs_auth.service_name
    platform      = module.ecs_platform.service_name
    "docpost-api" = module.ecs_docpost_api.service_name
  }

  name        = "${local.ssm_prefix}/ecs_service/${each.key}"
  description = "ECS service name for ${each.key}."
  type        = "String"
  value       = each.value
}

resource "aws_ssm_parameter" "lambda_function" {
  for_each = {
    fanout   = module.lambda_fanout.function_name
    delivery = module.lambda_delivery.function_name
    watchdog = module.lambda_watchdog.function_name
    ws       = module.lambda_ws_lifecycle.function_name
  }

  name        = "${local.ssm_prefix}/lambda/${each.key}"
  description = "Lambda function name for the ${each.key} worker."
  type        = "String"
  value       = each.value
}

resource "aws_ssm_parameter" "private_subnet_ids" {
  name        = "${local.ssm_prefix}/private_subnet_ids"
  description = "Private subnets for one-off ECS tasks (comma-separated)."
  type        = "StringList"
  value       = join(",", module.network.private_subnet_ids)
}

resource "aws_ssm_parameter" "db_bootstrap_task_family" {
  name        = "${local.ssm_prefix}/db_bootstrap/task_family"
  description = "Task definition family of the database bootstrap task."
  type        = "String"
  value       = module.db_bootstrap.task_definition_family
}

resource "aws_ssm_parameter" "db_task_security_group_id" {
  name        = "${local.ssm_prefix}/db_bootstrap/security_group_id"
  description = "Security group for one-off database tasks (bootstrap, migrations, seed)."
  type        = "String"
  value       = module.db_bootstrap.security_group_id
}

resource "aws_ssm_parameter" "rds_instance_identifier" {
  name        = "${local.ssm_prefix}/rds_instance_identifier"
  description = "Identifier of the dev RDS instance."
  type        = "String"
  value       = module.rds_instance.db_instance_identifier
}

resource "aws_ssm_parameter" "staging_bucket_name" {
  name        = "${local.ssm_prefix}/staging_bucket_name"
  description = "S3 bucket for staged uploads."
  type        = "String"
  value       = module.s3_staging.staging_bucket_name
}
