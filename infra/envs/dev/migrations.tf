# =============================================================================
# Dev split — state migration (dev -> dev-base)
#
# These objects are now owned by infra/envs/dev-base, which adopts them with
# `import` blocks. `destroy = false` makes Terraform drop them from this state
# without touching the real resources. The `moved` blocks follow the module
# calls that were renamed because part of their contents left this stack
# (a module that still declares a resource cannot be the target of `removed`).
#
# Apply dev-base before this stack. Once both have been applied, every block in
# this file is a no-op and the file can be deleted in a later change.
# Do not run `terraform destroy` here until `terraform apply` has processed
# these blocks.
# =============================================================================

# -- ECR, CDN: whole modules now in dev-base ------------------------------------
removed {
  from = module.ecr

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.cdn

  lifecycle {
    destroy = false
  }
}

# -- GitHub Actions deploy role --------------------------------------------------
removed {
  from = aws_iam_openid_connect_provider.github

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.github_deploy

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy.github_deploy

  lifecycle {
    destroy = false
  }
}

# -- S3: SPA bucket to dev-base; staging stays (module.s3 -> module.s3_staging) --
removed {
  from = module.s3.aws_s3_bucket.spa

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.s3.aws_s3_bucket_public_access_block.spa

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.s3.aws_s3_bucket_versioning.spa

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.s3.aws_s3_bucket_server_side_encryption_configuration.spa

  lifecycle {
    destroy = false
  }
}

moved {
  from = module.s3.aws_s3_bucket.staging
  to   = module.s3_staging.aws_s3_bucket.staging[0]
}

moved {
  from = module.s3.aws_s3_bucket_server_side_encryption_configuration.staging
  to   = module.s3_staging.aws_s3_bucket_server_side_encryption_configuration.staging[0]
}

moved {
  from = module.s3.aws_s3_bucket_public_access_block.staging
  to   = module.s3_staging.aws_s3_bucket_public_access_block.staging[0]
}

moved {
  from = module.s3.aws_s3_bucket_policy.staging_tls_only
  to   = module.s3_staging.aws_s3_bucket_policy.staging_tls_only[0]
}

moved {
  from = module.s3.aws_s3_bucket_lifecycle_configuration.staging
  to   = module.s3_staging.aws_s3_bucket_lifecycle_configuration.staging[0]
}

moved {
  from = module.s3.aws_s3_bucket_cors_configuration.staging
  to   = module.s3_staging.aws_s3_bucket_cors_configuration.staging[0]
}

moved {
  from = module.s3.aws_s3_bucket_versioning.staging
  to   = module.s3_staging.aws_s3_bucket_versioning.staging[0]
}

# -- API Gateway: API + stage to dev-base; VPC link, integration, routes stay ----
#    (module.api_gateway -> module.api_routes)
removed {
  from = module.api_gateway.aws_apigatewayv2_api.main

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.api_gateway.aws_apigatewayv2_stage.default

  lifecycle {
    destroy = false
  }
}

moved {
  from = module.api_gateway.aws_apigatewayv2_vpc_link.main
  to   = module.api_routes.aws_apigatewayv2_vpc_link.main[0]
}

moved {
  from = module.api_gateway.aws_apigatewayv2_integration.alb
  to   = module.api_routes.aws_apigatewayv2_integration.alb[0]
}

moved {
  from = module.api_gateway.aws_apigatewayv2_route.routes
  to   = module.api_routes.aws_apigatewayv2_route.routes
}

# -- RDS: secret containers to dev-base; instance and secret values stay ---------
#    (module.rds -> module.rds_instance)
removed {
  from = module.rds.aws_secretsmanager_secret.master_password

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.rds.aws_secretsmanager_secret.service_credentials

  lifecycle {
    destroy = false
  }
}

moved {
  from = module.rds.aws_db_subnet_group.main
  to   = module.rds_instance.aws_db_subnet_group.main
}

moved {
  from = module.rds.aws_security_group.rds
  to   = module.rds_instance.aws_security_group.rds
}

moved {
  from = module.rds.aws_db_instance.main
  to   = module.rds_instance.aws_db_instance.main
}

moved {
  from = module.rds.aws_secretsmanager_secret_version.master_password
  to   = module.rds_instance.aws_secretsmanager_secret_version.master_password
}

moved {
  from = module.rds.aws_secretsmanager_secret_version.service_credentials
  to   = module.rds_instance.aws_secretsmanager_secret_version.service_credentials
}
