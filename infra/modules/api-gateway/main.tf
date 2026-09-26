# -----------------------------------------------------------------------------
# API Gateway Module — HTTP API with VPC Link to Internal ALB
# ADR-001, ADR-007: API Gateway HTTP API + JWT Authorizer
#
# create_api covers the API and its stage (the stable URL); create_alb_integration
# covers the VPC link, integration, authorizer, and routes that need the ALB.
# Dev owns them in separate stacks so the URL survives a teardown.
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "api-gateway"
  }

  # The API can be owned by another stack (create_api = false); routes then attach to var.api_id.
  api_id = var.create_api ? aws_apigatewayv2_api.main[0].id : var.api_id
}

# -----------------------------------------------------------------------------
# VPC Link — connects API Gateway to the internal ALB
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_vpc_link" "main" {
  count = var.create_alb_integration ? 1 : 0

  name               = "${var.project_name}-${var.environment}-vpc-link"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = var.vpc_link_security_group_ids

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-vpc-link"
  })
}

# -----------------------------------------------------------------------------
# HTTP API
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "main" {
  count = var.create_api ? 1 : 0

  name          = "${var.project_name}-${var.environment}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = var.cors_allow_methods
    allow_headers = var.cors_allow_headers
    max_age       = 3600
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Default Stage with Auto-Deploy
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_stage" "default" {
  count = var.create_api ? 1 : 0

  api_id      = local.api_id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# JWT Authorizer — references auth service JWKS endpoint
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_authorizer" "jwt" {
  count = var.create_alb_integration && var.jwt_issuer != null ? 1 : 0

  api_id           = local.api_id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-${var.environment}-jwt"

  jwt_configuration {
    issuer   = var.jwt_issuer
    audience = var.jwt_audience
  }
}

# -----------------------------------------------------------------------------
# Integration — VPC Link to ALB
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_integration" "alb" {
  count = var.create_alb_integration ? 1 : 0

  api_id             = local.api_id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.alb_listener_arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main[0].id
}

# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_route" "routes" {
  for_each = var.create_alb_integration ? { for route in var.routes : route.route_key => route } : {}

  api_id    = local.api_id
  route_key = each.value.route_key
  target    = "integrations/${aws_apigatewayv2_integration.alb[0].id}"

  authorization_type = each.value.require_auth && length(aws_apigatewayv2_authorizer.jwt) > 0 ? "JWT" : "NONE"
  authorizer_id      = each.value.require_auth && length(aws_apigatewayv2_authorizer.jwt) > 0 ? aws_apigatewayv2_authorizer.jwt[0].id : null
}
