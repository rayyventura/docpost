# -----------------------------------------------------------------------------
# Prod Environment — Root Configuration
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  # Backend values come from bootstrap output:
  #   cd bootstrap && terraform output
  # Then fill in bucket, dynamodb_table below.
  backend "s3" {
    bucket         = "REPLACE_WITH_BOOTSTRAP_OUTPUT" # state_bucket_name
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "REPLACE_WITH_BOOTSTRAP_OUTPUT" # lock_table_name
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
# ECR
# =============================================================================
module "ecr" {
  source = "../../modules/ecr"

  project_name = var.project_name
  environment  = var.environment
}

# =============================================================================
# S3
# =============================================================================
module "s3" {
  source = "../../modules/s3"

  project_name        = var.project_name
  environment         = var.environment
  staging_bucket_name = "${var.project_name}-${var.environment}-staging"
  spa_bucket_name     = "${var.project_name}-${var.environment}-spa"
  cors_allowed_origins = var.spa_cors_origins
}

# =============================================================================
# SQS
# =============================================================================
module "sqs" {
  source = "../../modules/sqs"

  project_name        = var.project_name
  environment         = var.environment
  staging_bucket_name = module.s3.staging_bucket_name
  staging_bucket_arn  = module.s3.staging_bucket_arn
}

# =============================================================================
# RDS
# =============================================================================
module "rds" {
  source = "../../modules/rds"

  project_name   = var.project_name
  environment    = var.environment
  vpc_id         = module.network.vpc_id
  vpc_cidr_block = module.network.vpc_cidr_block
  private_subnet_ids = module.network.private_subnet_ids

  instance_class          = var.rds_instance_class
  master_password         = var.rds_master_password
  skip_final_snapshot     = false
  multi_az                = var.rds_multi_az
  backup_retention_period = 7

  client_security_group_ids = [
    module.ecs_auth.security_group_id,
    module.ecs_platform.security_group_id,
    module.ecs_docpost_api.security_group_id,
  ]
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

  container_image = "${module.ecr.repository_urls["auth"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count

  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["auth_service"]]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["auth_service"]
  }

  environment_variables = {
    NODE_ENV = var.environment
    PORT     = "3000"
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

  container_image = "${module.ecr.repository_urls["platform"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count
  cluster_arn     = module.ecs_auth.cluster_arn

  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["platform_service"]]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["platform_service"]
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

  container_image = "${module.ecr.repository_urls["docpost-api"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count
  cluster_arn     = module.ecs_auth.cluster_arn

  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["docpost_service"]]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["docpost_service"]
  }

  environment_variables = {
    NODE_ENV = var.environment
    PORT     = "3000"
  }
}

# =============================================================================
# API Gateway
# =============================================================================
module "api_gateway" {
  source = "../../modules/api-gateway"

  project_name               = var.project_name
  environment                = var.environment
  private_subnet_ids         = module.network.private_subnet_ids
  vpc_link_security_group_ids = [module.alb.security_group_id]
  alb_listener_arn           = module.alb.listener_arn

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
  handler       = "index.handler"
  memory_size   = 256
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
    TASK_QUEUE_URL = module.sqs.queue_urls["tasks"]
  }
}

module "lambda_delivery" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "delivery"
  handler       = "index.handler"
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
    NODE_ENV = var.environment
  }
}

module "lambda_watchdog" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "watchdog"
  handler       = "index.handler"
  memory_size   = 128
  timeout       = 60

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

module "lambda_ws_lifecycle" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "ws-lifecycle"
  handler       = "index.handler"
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
