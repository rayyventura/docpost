output "api_endpoint" {
  description = "Invoke URL for the API Gateway HTTP API."
  value       = one(aws_apigatewayv2_api.main[*].api_endpoint)
}

output "api_id" {
  description = "ID of the API Gateway HTTP API."
  value       = local.api_id
}

output "vpc_link_id" {
  description = "ID of the VPC Link."
  value       = one(aws_apigatewayv2_vpc_link.main[*].id)
}

output "stage_id" {
  description = "ID of the default stage."
  value       = one(aws_apigatewayv2_stage.default[*].id)
}
