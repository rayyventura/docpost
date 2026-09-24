output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.service.name
}

output "service_arn" {
  description = "ARN of the ECS service."
  value       = aws_ecs_service.service.id
}

output "task_definition_arn" {
  description = "ARN of the task definition."
  value       = aws_ecs_task_definition.service.arn
}

output "security_group_id" {
  description = "Security group ID of the ECS service."
  value       = aws_security_group.service.id
}

output "task_role_arn" {
  description = "ARN of the ECS task IAM role."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "ARN of the ECS execution IAM role."
  value       = aws_iam_role.execution.arn
}

output "cluster_arn" {
  description = "ARN of the ECS cluster (created or provided)."
  value       = local.cluster_arn
}
