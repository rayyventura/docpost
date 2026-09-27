# -----------------------------------------------------------------------------
# WebSocket API — $connect / $disconnect / subscribe for live delivery updates
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "websocket-api"
  }

  routes = ["$connect", "$disconnect", "$default", "subscribe"]
}

resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.project_name}-${var.environment}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-ws"
  })
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id             = aws_apigatewayv2_api.ws.id
  integration_type   = "AWS_PROXY"
  integration_uri    = var.lambda_invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = toset(local.routes)

  api_id    = aws_apigatewayv2_api.ws.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route_response" "two_way" {
  for_each = toset(["subscribe", "$default"])

  api_id             = aws_apigatewayv2_api.ws.id
  route_id           = aws_apigatewayv2_route.routes[each.value].id
  route_response_key = "$default"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}
