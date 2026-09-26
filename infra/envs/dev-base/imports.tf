# =============================================================================
# One-time adoption of resources that infra/envs/dev created before the split.
#
# infra/envs/dev has matching `removed { lifecycle { destroy = false } }`
# blocks, so each object moves from the dev state to this one without being
# destroyed or recreated. Once this stack has been applied these blocks are
# no-ops and can be deleted in a later change.
#
# IDs are the live dev objects as of the split. If dev is rebuilt from scratch
# before this lands, re-read them (terraform -chdir=infra/envs/dev state show).
# =============================================================================

# -- ECR ----------------------------------------------------------------------
import {
  for_each = toset(["auth", "platform", "docpost-api"])
  to       = module.ecr.aws_ecr_repository.services[each.key]
  id       = "docpost/${each.key}"
}

import {
  for_each = toset(["auth", "platform", "docpost-api"])
  to       = module.ecr.aws_ecr_lifecycle_policy.services[each.key]
  id       = "docpost/${each.key}"
}

# -- S3 (SPA bucket) -----------------------------------------------------------
import {
  to = module.s3.aws_s3_bucket.spa[0]
  id = "docpost-dev-spa"
}

import {
  to = module.s3.aws_s3_bucket_public_access_block.spa[0]
  id = "docpost-dev-spa"
}

import {
  to = module.s3.aws_s3_bucket_versioning.spa[0]
  id = "docpost-dev-spa"
}

import {
  to = module.s3.aws_s3_bucket_server_side_encryption_configuration.spa[0]
  id = "docpost-dev-spa"
}

# -- CDN ----------------------------------------------------------------------
import {
  to = module.cdn.aws_cloudfront_origin_access_control.spa
  id = "E22YNTKC7C8C6U"
}

import {
  to = module.cdn.aws_cloudfront_distribution.spa
  id = "EKV2FIAUQ3NMP"
}

import {
  to = module.cdn.aws_s3_bucket_policy.spa_cloudfront
  id = "docpost-dev-spa"
}

# -- API Gateway ----------------------------------------------------------------
import {
  to = module.api_gateway.aws_apigatewayv2_api.main[0]
  id = "sqkzppgzuf"
}

import {
  to = module.api_gateway.aws_apigatewayv2_stage.default[0]
  id = "sqkzppgzuf/$default"
}

# -- RDS secrets ----------------------------------------------------------------
import {
  to = aws_secretsmanager_secret.rds_master_password
  id = "arn:aws:secretsmanager:us-east-1:448571506838:secret:docpost/dev/rds/master-password-1w22Ab"
}

import {
  for_each = {
    auth_service     = "arn:aws:secretsmanager:us-east-1:448571506838:secret:docpost/dev/rds/auth_service-LTWiWP"
    platform_service = "arn:aws:secretsmanager:us-east-1:448571506838:secret:docpost/dev/rds/platform_service-KcF3rv"
    docpost_service  = "arn:aws:secretsmanager:us-east-1:448571506838:secret:docpost/dev/rds/docpost_service-GuRIPB"
  }
  to = aws_secretsmanager_secret.rds_service_credentials[each.key]
  id = each.value
}

# -- GitHub Actions deploy role -------------------------------------------------
import {
  to = aws_iam_openid_connect_provider.github
  id = "arn:aws:iam::448571506838:oidc-provider/token.actions.githubusercontent.com"
}

import {
  to = aws_iam_role.github_deploy
  id = "docpost-dev-github-deploy"
}

import {
  to = aws_iam_role_policy.github_deploy
  id = "docpost-dev-github-deploy:docpost-dev-github-deploy"
}
