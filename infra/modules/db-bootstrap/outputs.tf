output "task_definition_family" {
  description = "Family of the bootstrap task definition. Run it by family to get the latest revision."
  value       = aws_ecs_task_definition.bootstrap.family
}

output "task_definition_arn" {
  description = "ARN of the bootstrap task definition revision."
  value       = aws_ecs_task_definition.bootstrap.arn
}

output "security_group_id" {
  description = "Security group for one-off database tasks (bootstrap, migrations, seed)."
  value       = aws_security_group.task.id
}

output "execution_role_arn" {
  description = "ARN of the bootstrap task's execution role."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "CloudWatch log group the bootstrap task writes to."
  value       = aws_cloudwatch_log_group.bootstrap.name
}
