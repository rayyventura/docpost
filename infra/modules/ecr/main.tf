# -----------------------------------------------------------------------------
# ECR Module — Container Repositories for ECS Services
# -----------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    Module      = "ecr"
  }
}

resource "aws_ecr_repository" "services" {
  for_each = toset(var.service_names)

  name                 = "${var.project_name}/${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Name    = "${var.project_name}-${each.key}"
    Service = each.key
  })
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each = toset(var.service_names)

  repository = aws_ecr_repository.services[each.key].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.max_image_count} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.max_image_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
