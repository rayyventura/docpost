# -----------------------------------------------------------------------------
# Prod Environment — Root Configuration
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  # Backend values come from bootstrap output:
  #   cd bootstrap && terraform output
  # Then fill in bucket, dynamodb_table below.
  backend "s3" {
    bucket         = "docpost-terraform-state-85db398b" # state_bucket_name
    key            = "prod/terraform.tfstate"
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
      # /.well-known/* serves the JWKS that other services verify tokens with.
      path_patterns     = ["/auth/*", "/.well-known/*"]
      priority          = 100
    },
    {
      name              = "platform"
      port              = 3000
      health_check_path = "/health"
      # Services call the platform without a /platform prefix.
      # /internal/* is service-to-service only; API Gateway does not route it.
      path_patterns     = ["/teams*", "/binders/*", "/folders/*", "/documents*", "/internal/*"]
      priority          = 200
    },
    {
      name              = "docpost-api"
      port              = 3000
      health_check_path = "/health"
      path_patterns     = ["/destinations/*", "/jobs*", "/files/*"]
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

  target_group_arn       = module.alb.target_group_arns["auth"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["auth_service"]]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["auth_service"]
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

  container_image = "${module.ecr.repository_urls["platform"]}:latest"
  container_port  = 3000
  cpu             = var.ecs_cpu
  memory          = var.ecs_memory
  desired_count   = var.ecs_desired_count
  create_cluster  = false
  cluster_arn     = module.ecs_auth.cluster_arn

  target_group_arn       = module.alb.target_group_arns["platform"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["platform_service"]]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["platform_service"]
  }

  task_role_policy_arns = [aws_iam_policy.platform_runtime.arn]

  environment_variables = {
    NODE_ENV      = var.environment
    PORT          = "3000"
    AWS_REGION    = var.region
    AUTH_JWKS_URL = "http://${module.alb.alb_dns_name}/.well-known/jwks.json"
    S3_BUCKET     = module.s3.staging_bucket_name
  }
}

resource "aws_iam_policy" "platform_runtime" {
  name = "${var.project_name}-${var.environment}-platform-runtime"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = "${module.s3.staging_bucket_arn}/documents/*"
      },
    ]
  })
}

resource "aws_iam_policy" "docpost_api_runtime" {
  name = "${var.project_name}-${var.environment}-docpost-api-runtime"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ]
        Resource = "${module.s3.staging_bucket_arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
        ]
        Resource = [module.sqs.queue_arns["jobs"]]
      },
    ]
  })
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
  create_cluster  = false
  cluster_arn     = module.ecs_auth.cluster_arn

  target_group_arn       = module.alb.target_group_arns["docpost-api"]
  alb_security_group_ids = [module.alb.security_group_id]
  secret_arns            = [module.rds.secret_arns["docpost_service"]]
  task_role_policy_arns  = [aws_iam_policy.docpost_api_runtime.arn]

  secrets = {
    DATABASE_URL = module.rds.secret_arns["docpost_service"]
  }

  environment_variables = {
    NODE_ENV       = var.environment
    PORT           = "3000"
    AWS_REGION     = var.region
    PLATFORM_URL   = "http://${module.alb.alb_dns_name}"
    AUTH_JWKS_URL  = "http://${module.alb.alb_dns_name}/.well-known/jwks.json"
    AUTH_TOKEN_URL = "http://${module.alb.alb_dns_name}/auth/token"
    S3_BUCKET      = module.s3.staging_bucket_name
    JOB_QUEUE_URL                 = module.sqs.queue_urls["jobs"]
    TOTAL_SUPPORTED_DESTINATIONS  = tostring(var.total_supported_destinations)
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
    { route_key = "POST /auth/{proxy+}", require_auth = false },
    { route_key = "GET /.well-known/{proxy+}", require_auth = false },
    { route_key = "GET /destinations/{proxy+}", require_auth = true },
    { route_key = "GET /jobs", require_auth = true },
    { route_key = "POST /jobs", require_auth = true },
    { route_key = "GET /jobs/{proxy+}", require_auth = true },
    { route_key = "POST /files/{proxy+}", require_auth = true },
  ]
}

# =============================================================================
# Lambda Workers
# =============================================================================
data "aws_secretsmanager_secret_version" "docpost_service" {
  secret_id = module.rds.secret_arns["docpost_service"]
}

resource "aws_iam_policy" "lambda_workers_runtime" {
  name = "${var.project_name}-${var.environment}-lambda-workers-runtime"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
        ]
        Resource = "${module.s3.staging_bucket_arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
        ]
        Resource = [
          module.sqs.queue_arns["tasks"],
          module.sqs.queue_arns["jobs"],
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = module.rds.secret_arns["docpost_service"]
      },
    ]
  })
}

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
  policy_arns      = [aws_iam_policy.lambda_workers_runtime.arn]

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
    NODE_ENV            = var.environment
    S3_BUCKET           = module.s3.staging_bucket_name
    TASK_QUEUE_URL      = module.sqs.queue_urls["tasks"]
    DATABASE_URL        = data.aws_secretsmanager_secret_version.docpost_service.secret_string
    DATABASE_SECRET_ARN = module.rds.secret_arns["docpost_service"]
  }
}

module "lambda_delivery" {
  source = "../../modules/lambda"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "delivery"
  handler       = "handler.handler"
  memory_size   = 1024
  timeout       = 60

  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256
  policy_arns      = [aws_iam_policy.lambda_workers_runtime.arn]

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
    NODE_ENV            = var.environment
    S3_BUCKET           = module.s3.staging_bucket_name
    PLATFORM_URL        = "http://${module.alb.alb_dns_name}"
    AUTH_TOKEN_URL      = "http://${module.alb.alb_dns_name}/auth/token"
    DATABASE_URL        = data.aws_secretsmanager_secret_version.docpost_service.secret_string
    DATABASE_SECRET_ARN = module.rds.secret_arns["docpost_service"]
    WS_CALLBACK_URL     = module.websocket_api.callback_url
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
  policy_arns      = [aws_iam_policy.lambda_workers_runtime.arn]

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
    NODE_ENV            = var.environment
    S3_BUCKET           = module.s3.staging_bucket_name
    TASK_QUEUE_URL      = module.sqs.queue_urls["tasks"]
    JOB_QUEUE_URL       = module.sqs.queue_urls["jobs"]
    DATABASE_URL        = data.aws_secretsmanager_secret_version.docpost_service.secret_string
    DATABASE_SECRET_ARN = module.rds.secret_arns["docpost_service"]
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
  policy_arns      = [aws_iam_policy.lambda_workers_runtime.arn]

  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.ecs_auth.security_group_id]
  }

  environment_variables = {
    NODE_ENV            = var.environment
    DATABASE_URL        = data.aws_secretsmanager_secret_version.docpost_service.secret_string
    DATABASE_SECRET_ARN = module.rds.secret_arns["docpost_service"]
    PLATFORM_URL        = "http://${module.alb.alb_dns_name}"
    AUTH_TOKEN_URL      = "http://${module.alb.alb_dns_name}/auth/token"
    AUTH_JWKS_URL       = "http://${module.alb.alb_dns_name}/.well-known/jwks.json"
  }
}

module "websocket_api" {
  source = "../../modules/websocket-api"

  project_name         = var.project_name
  environment          = var.environment
  lambda_invoke_arn    = module.lambda_ws_lifecycle.invoke_arn
  lambda_function_name = module.lambda_ws_lifecycle.function_name
}

resource "aws_iam_role_policy" "delivery_manage_connections" {
  name = "${var.project_name}-${var.environment}-delivery-ws"
  role = module.lambda_delivery.role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${module.websocket_api.execution_arn}/*"
      },
    ]
  })
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
