output "function_name" {
  description = "Name of the Lambda function."
  value       = aws_lambda_function.function.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function."
  value       = aws_lambda_function.function.arn
}

output "invoke_arn" {
  description = "Invoke ARN of the Lambda function (for API Gateway integrations)."
  value       = aws_lambda_function.function.invoke_arn
}

output "role_arn" {
  description = "ARN of the Lambda execution IAM role."
  value       = aws_iam_role.execution.arn
}

output "role_name" {
  description = "Name of the Lambda execution IAM role."
  value       = aws_iam_role.execution.name
}
