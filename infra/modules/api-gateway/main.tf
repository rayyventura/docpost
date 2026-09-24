# -----------------------------------------------------------------------------
# API Gateway Module — HTTP API with VPC Link to Internal ALB
# ADR-001, ADR-007: API Gateway HTTP API + JWT Authorizer
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "api-gateway"
  }
}

# -----------------------------------------------------------------------------
# VPC Link — connects API Gateway to the internal ALB
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_vpc_link" "main" {
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
  api_id      = aws_apigatewayv2_api.main.id
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
  count = var.jwt_issuer != null ? 1 : 0

  api_id           = aws_apigatewayv2_api.main.id
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
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.alb_listener_arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id
}

# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_route" "routes" {
  for_each = { for route in var.routes : route.route_key => route }

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value.route_key
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"

  authorization_type = each.value.require_auth ? "JWT" : "NONE"
  authorizer_id      = each.value.require_auth && length(aws_apigatewayv2_authorizer.jwt) > 0 ? aws_apigatewayv2_authorizer.jwt[0].id : null
}
