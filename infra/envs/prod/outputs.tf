# =============================================================================
# Prod Environment — Outputs
# =============================================================================

# -- Network ------------------------------------------------------------------
output "vpc_id" {
  description = "VPC ID."
  value       = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs."
  value       = module.network.private_subnet_ids
}

output "public_subnet_ids" {
  description = "Public subnet IDs."
  value       = module.network.public_subnet_ids
}

# -- ECR ----------------------------------------------------------------------
output "ecr_repository_urls" {
  description = "Map of service name to ECR repository URL."
  value       = module.ecr.repository_urls
}

# -- S3 -----------------------------------------------------------------------
output "staging_bucket_name" {
  description = "Staging S3 bucket name."
  value       = module.s3.staging_bucket_name
}

output "spa_bucket_name" {
  description = "SPA hosting S3 bucket name."
  value       = module.s3.spa_bucket_name
}

# -- SQS ----------------------------------------------------------------------
output "queue_urls" {
  description = "Map of SQS queue URLs."
  value       = module.sqs.queue_urls
}

# -- RDS ----------------------------------------------------------------------
output "rds_proxy_endpoint" {
  description = "RDS Proxy connection endpoint."
  value       = module.rds.rds_proxy_endpoint
}

output "rds_instance_endpoint" {
  description = "RDS instance connection endpoint (direct, for admin only)."
  value       = module.rds.db_instance_endpoint
}

# -- ALB ----------------------------------------------------------------------
output "alb_dns_name" {
  description = "DNS name of the internal ALB."
  value       = module.alb.alb_dns_name
}

# -- API Gateway ---------------------------------------------------------------
output "api_endpoint" {
  description = "API Gateway invoke URL."
  value       = module.api_gateway.api_endpoint
}

# -- CDN -----------------------------------------------------------------------
output "cdn_domain_name" {
  description = "CloudFront distribution domain name."
  value       = module.cdn.distribution_domain_name
}

# -- ECS ----------------------------------------------------------------------
output "ecs_cluster_arn" {
  description = "ECS cluster ARN."
  value       = module.ecs_auth.cluster_arn
}
