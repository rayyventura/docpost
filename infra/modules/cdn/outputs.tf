output "distribution_id" {
  description = "ID of the CloudFront distribution."
  value       = aws_cloudfront_distribution.spa.id
}

output "distribution_domain_name" {
  description = "Domain name of the CloudFront distribution."
  value       = aws_cloudfront_distribution.spa.domain_name
}

output "distribution_arn" {
  description = "ARN of the CloudFront distribution."
  value       = aws_cloudfront_distribution.spa.arn
}
