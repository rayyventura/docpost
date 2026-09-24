# -----------------------------------------------------------------------------
# CDN Module — CloudFront Distribution for SPA
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "cdn"
  }

  s3_origin_id = "${var.project_name}-${var.environment}-spa-origin"
}

# -----------------------------------------------------------------------------
# Origin Access Control — S3 access for CloudFront
# -----------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.project_name}-${var.environment}-spa-oac"
  description                       = "OAC for SPA S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# CloudFront Distribution
# -----------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "spa" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # US, Canada, Europe
  comment             = "${var.project_name} ${var.environment} SPA"

  origin {
    domain_name              = var.spa_bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id = null
  }

  # SPA routing: serve index.html for 403/404
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-cdn"
  })
}

# -----------------------------------------------------------------------------
# Managed Cache Policy — CachingOptimized
# -----------------------------------------------------------------------------
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# -----------------------------------------------------------------------------
# S3 Bucket Policy — Allow CloudFront OAC to read from SPA bucket
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_policy" "spa_cloudfront" {
  bucket = var.spa_bucket_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipalReadOnly"
        Effect    = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${var.spa_bucket_arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.spa.arn
          }
        }
      }
    ]
  })
}
