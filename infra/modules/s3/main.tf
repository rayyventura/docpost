# -----------------------------------------------------------------------------
# S3 Module — Staging Bucket (SSE-KMS) + SPA Hosting Bucket
# ADR-003: SSE-KMS with aws/s3 managed key + Bucket Keys
#
# create_staging_bucket / create_spa_bucket let two stacks each own one bucket
# (dev keeps staging in the teardown layer and SPA hosting in dev-base).
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
  count = var.create_staging_bucket ? 1 : 0

  bucket        = var.staging_bucket_name
  force_destroy = var.staging_force_destroy

  tags = merge(local.common_tags, {
    Name    = var.staging_bucket_name
    Purpose = "staging"
  })
}

# SSE-KMS with aws/s3 managed key + Bucket Keys (ADR-003)
resource "aws_s3_bucket_server_side_encryption_configuration" "staging" {
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "staging" {
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# TLS-only bucket policy (deny non-SSL requests)
resource "aws_s3_bucket_policy" "staging_tls_only" {
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonSSLRequests"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.staging[0].arn,
          "${aws_s3_bucket.staging[0].arn}/*"
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
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

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
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

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
  count = var.create_staging_bucket ? 1 : 0

  bucket = aws_s3_bucket.staging[0].id

  versioning_configuration {
    status = "Suspended"
  }
}

# =============================================================================
# SPA Hosting Bucket
# =============================================================================
resource "aws_s3_bucket" "spa" {
  count = var.create_spa_bucket ? 1 : 0

  bucket = var.spa_bucket_name

  tags = merge(local.common_tags, {
    Name    = var.spa_bucket_name
    Purpose = "spa-hosting"
  })
}

# Block public access (CloudFront uses OAC)
resource "aws_s3_bucket_public_access_block" "spa" {
  count = var.create_spa_bucket ? 1 : 0

  bucket = aws_s3_bucket.spa[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "spa" {
  count = var.create_spa_bucket ? 1 : 0

  bucket = aws_s3_bucket.spa[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  count = var.create_spa_bucket ? 1 : 0

  bucket = aws_s3_bucket.spa[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
