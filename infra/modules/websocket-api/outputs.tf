output "api_id" {
  description = "ID of the WebSocket API."
  value       = aws_apigatewayv2_api.ws.id
}

output "client_url" {
  description = "Browser WebSocket URL (wss://)."
  value       = aws_apigatewayv2_api.ws.api_endpoint
}

output "callback_url" {
  description = "Management API endpoint used to PostToConnection."
  value       = "${replace(aws_apigatewayv2_api.ws.api_endpoint, "wss://", "https://")}/${aws_apigatewayv2_stage.default.name}"
}

output "execution_arn" {
  description = "Execution ARN of the WebSocket API."
  value       = aws_apigatewayv2_api.ws.execution_arn
}
