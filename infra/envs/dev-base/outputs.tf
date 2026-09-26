# =============================================================================
# Dev Base — Outputs
# infra/envs/dev reads these through terraform_remote_state. Renaming or
# removing one breaks the dev plan.
# =============================================================================

# -- ECR ----------------------------------------------------------------------
output "ecr_repository_urls" {
  description = "Map of service name to ECR repository URL."
  value       = module.ecr.repository_urls
}

# -- S3 -----------------------------------------------------------------------
output "spa_bucket_name" {
  description = "SPA hosting S3 bucket name."
  value       = module.s3.spa_bucket_name
}

output "spa_bucket_arn" {
  description = "SPA hosting S3 bucket ARN."
  value       = module.s3.spa_bucket_arn
}

# -- CDN -----------------------------------------------------------------------
output "cdn_distribution_id" {
  description = "CloudFront distribution ID."
  value       = module.cdn.distribution_id
}

output "cdn_domain_name" {
  description = "CloudFront distribution domain name."
  value       = module.cdn.distribution_domain_name
}

# -- API Gateway ---------------------------------------------------------------
output "api_id" {
  description = "ID of the HTTP API. Dev attaches its routes to it."
  value       = module.api_gateway.api_id
}

output "api_endpoint" {
  description = "API Gateway invoke URL."
  value       = module.api_gateway.api_endpoint
}

# -- Secrets -------------------------------------------------------------------
output "rds_master_secret_arn" {
  description = "ARN of the RDS master-password secret."
  value       = aws_secretsmanager_secret.rds_master_password.arn
}

output "rds_service_secret_arns" {
  description = "Map of service name to the ARN of its database-credentials secret."
  value       = { for name, s in aws_secretsmanager_secret.rds_service_credentials : name => s.arn }
}

# -- CI/CD ---------------------------------------------------------------------
output "github_deploy_role_arn" {
  description = "IAM role GitHub Actions assumes to deploy dev."
  value       = aws_iam_role.github_deploy.arn
}

output "ssm_parameter_prefix" {
  description = "Parameter Store prefix holding the values CI/CD reads."
  value       = local.ssm_prefix
}
