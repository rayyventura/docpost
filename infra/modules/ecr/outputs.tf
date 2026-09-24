output "repository_urls" {
  description = "Map of service name to ECR repository URL."
  value = {
    for name in var.service_names :
    name => aws_ecr_repository.services[name].repository_url
  }
}

output "repository_arns" {
  description = "Map of service name to ECR repository ARN."
  value = {
    for name in var.service_names :
    name => aws_ecr_repository.services[name].arn
  }
}
