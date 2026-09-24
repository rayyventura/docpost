# -----------------------------------------------------------------------------
# S3 Module — Staging Bucket (SSE-KMS) + SPA Hosting Bucket
# ADR-003: SSE-KMS with aws/s3 managed key + Bucket Keys
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "s3"
  }
}

# =============================================================================
# Staging Bucket — uploaded files (transient)
# =============================================================================
resource "aws_s3_bucket" "staging" {
  bucket = var.staging_bucket_name

  tags = merge(local.common_tags, {
    Name    = var.staging_bucket_name
    Purpose = "staging"
  })
}

# SSE-KMS with aws/s3 managed key + Bucket Keys (ADR-003)
resource "aws_s3_bucket_server_side_encryption_configuration" "staging" {
  bucket = aws_s3_bucket.staging.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "staging" {
  bucket = aws_s3_bucket.staging.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# TLS-only bucket policy (deny non-SSL requests)
resource "aws_s3_bucket_policy" "staging_tls_only" {
  bucket = aws_s3_bucket.staging.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonSSLRequests"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.staging.arn,
          "${aws_s3_bucket.staging.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.staging]
}

# Lifecycle rules: delete after 30 days, abort incomplete multipart after 7 days
resource "aws_s3_bucket_lifecycle_configuration" "staging" {
  bucket = aws_s3_bucket.staging.id

  rule {
    id     = "delete-after-30-days"
    status = "Enabled"

    expiration {
      days = 30
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CORS configuration for browser uploads
resource "aws_s3_bucket_cors_configuration" "staging" {
  bucket = aws_s3_bucket.staging.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# Versioning disabled (staging files are transient)
resource "aws_s3_bucket_versioning" "staging" {
  bucket = aws_s3_bucket.staging.id

  versioning_configuration {
    status = "Suspended"
  }
}

# =============================================================================
# SPA Hosting Bucket
# =============================================================================
resource "aws_s3_bucket" "spa" {
  bucket = var.spa_bucket_name

  tags = merge(local.common_tags, {
    Name    = var.spa_bucket_name
    Purpose = "spa-hosting"
  })
}

# Block public access (CloudFront uses OAC)
resource "aws_s3_bucket_public_access_block" "spa" {
  bucket = aws_s3_bucket.spa.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "spa" {
  bucket = aws_s3_bucket.spa.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
