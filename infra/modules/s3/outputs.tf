output "staging_bucket_name" {
  description = "Name of the staging S3 bucket."
  value       = aws_s3_bucket.staging.id
}

output "staging_bucket_arn" {
  description = "ARN of the staging S3 bucket."
  value       = aws_s3_bucket.staging.arn
}

output "spa_bucket_name" {
  description = "Name of the SPA hosting S3 bucket."
  value       = aws_s3_bucket.spa.id
}

output "spa_bucket_arn" {
  description = "ARN of the SPA hosting S3 bucket."
  value       = aws_s3_bucket.spa.arn
}

output "spa_bucket_regional_domain_name" {
  description = "Regional domain name of the SPA bucket (for CloudFront origin)."
  value       = aws_s3_bucket.spa.bucket_regional_domain_name
}
