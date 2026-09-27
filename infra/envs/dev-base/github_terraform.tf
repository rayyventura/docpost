# -----------------------------------------------------------------------------
# GitHub Actions Terraform roles (OIDC)
#
#   docpost-dev-github-terraform-plan  read-only; `terraform plan` on pull
#                                      requests and on pushes to main
#   docpost-dev-github-terraform       read-write; `terraform apply`/`destroy`
#                                      of dev-base and dev, only from jobs that
#                                      run in the GitHub environment "dev"
#
# Chicken-and-egg: CI cannot create the roles it assumes. Apply this stack
# once by hand (terraform apply in infra/envs/dev-base) before adding
# AWS_TERRAFORM_ROLE_ARN / AWS_TERRAFORM_PLAN_ROLE_ARN to the repository.
#
# The "dev" GitHub environment must only allow deployments from main
# (Settings -> Environments -> dev -> Deployment branches). The token's `sub`
# for an environment job is repo:<repo>:environment:dev; it carries no branch,
# so that setting is what keeps other branches away from the apply role.
#
# Scoping: name prefixes (docpost-dev-*, docpost/dev/*, /docpost/dev/*) where
# the service's ARNs carry a name. EC2, API Gateway and CloudFront ARNs only
# carry generated IDs, and EC2 creates/changes several resource types per call
# (subnets, route tables, ENIs, EIPs, SG rules), so those are service-wide
# within this region. The apply role can create IAM roles under
# docpost-dev-*, which is the one real escalation path: whoever can run it can
# write an inline policy on such a role. Only the two AWS managed policies the
# modules use can be attached.
# -----------------------------------------------------------------------------

locals {
  state_bucket = "docpost-terraform-state-85db398b"
  lock_table   = "docpost-terraform-lock"

  # State keys this stack pair owns; the lock table's LockID is "<bucket>/<key>[-md5]".
  state_prefixes = ["dev/", "dev-base/"]

  oidc_sub = "token.actions.githubusercontent.com:sub"
  oidc_aud = "token.actions.githubusercontent.com:aud"

  # Read the state of both stacks (dev reads dev-base through remote state)
  # and take/release their locks.
  terraform_state_read_statements = [
    {
      Sid      = "StateBucketList"
      Effect   = "Allow"
      Action   = ["s3:ListBucket", "s3:GetBucketVersioning", "s3:GetBucketLocation"]
      Resource = "arn:aws:s3:::${local.state_bucket}"
    },
    {
      Sid    = "StateObjectsRead"
      Effect = "Allow"
      Action = ["s3:GetObject"]
      Resource = [
        for prefix in local.state_prefixes : "arn:aws:s3:::${local.state_bucket}/${prefix}*"
      ]
    },
    {
      Sid      = "StateLockTable"
      Effect   = "Allow"
      Action   = ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      Resource = "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${local.lock_table}"
      Condition = {
        "ForAllValues:StringLike" = {
          "dynamodb:LeadingKeys" = [for prefix in local.state_prefixes : "${local.state_bucket}/${prefix}*"]
        }
      }
    },
  ]

  terraform_state_write_statements = [
    {
      Sid    = "StateObjectsWrite"
      Effect = "Allow"
      Action = ["s3:PutObject", "s3:DeleteObject"]
      Resource = [
        for prefix in local.state_prefixes : "arn:aws:s3:::${local.state_bucket}/${prefix}*"
      ]
    },
  ]
}

# =============================================================================
# Plan role (read-only)
# =============================================================================
resource "aws_iam_role" "github_terraform_plan" {
  name        = "${local.name_prefix}-github-terraform-plan"
  description = "terraform plan for dev-base and dev from GitHub Actions (pull requests and main)."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          (local.oidc_aud) = "sts.amazonaws.com"
          (local.oidc_sub) = [
            "repo:${local.github_repository}:pull_request",
            "repo:${local.github_repository}:ref:refs/heads/main",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_terraform_plan" {
  name = "${local.name_prefix}-github-terraform-plan"
  role = aws_iam_role.github_terraform_plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.terraform_state_read_statements, [
      {
        # Refresh. Describe/List calls mostly do not support resource-level
        # permissions, so they are account-wide but read-only.
        Sid    = "ReadInfrastructure"
        Effect = "Allow"
        Action = [
          "apigateway:GET",
          "cloudfront:Get*",
          "cloudfront:List*",
          "ec2:Describe*",
          "ecr:DescribeRepositories",
          "ecr:GetLifecyclePolicy",
          "ecr:ListTagsForResource",
          "ecs:Describe*",
          "ecs:List*",
          "elasticloadbalancing:Describe*",
          "iam:GetOpenIDConnectProvider",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListOpenIDConnectProviders",
          "iam:ListRolePolicies",
          "iam:ListRoleTags",
          "kms:DescribeKey",
          "lambda:Get*",
          "lambda:List*",
          "logs:DescribeLogGroups",
          "logs:ListTagsForResource",
          "logs:ListTagsLogGroup",
          "rds:Describe*",
          "rds:ListTagsForResource",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ListQueueTags",
          "sqs:ListQueues",
          "ssm:DescribeParameters",
        ]
        Resource = "*"
      },
      {
        Sid      = "ReadBuckets"
        Effect   = "Allow"
        Action   = ["s3:GetBucket*", "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration", "s3:GetAccelerateConfiguration", "s3:GetReplicationConfiguration", "s3:GetAnalyticsConfiguration", "s3:GetIntelligentTieringConfiguration", "s3:GetInventoryConfiguration", "s3:GetMetricsConfiguration", "s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.name_prefix}-*"
      },
      {
        Sid      = "ReadParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource"]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        # aws_secretsmanager_secret_version refreshes by reading the value.
        # The state itself holds the master password, so this adds nothing
        # the state read above does not already allow.
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.project_name}/${var.environment}/*"
      },
    ])
  })
}

# =============================================================================
# Apply role
# =============================================================================
resource "aws_iam_role" "github_terraform" {
  name        = "${local.name_prefix}-github-terraform"
  description = "terraform apply/destroy for dev-base and dev from GitHub Actions (environment dev only)."

  # Long applies (RDS, CloudFront) outlast the 1h default.
  max_session_duration = 7200

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          (local.oidc_aud) = "sts.amazonaws.com"
          (local.oidc_sub) = "repo:${local.github_repository}:environment:${var.environment}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_terraform" {
  name = "${local.name_prefix}-github-terraform"
  role = aws_iam_role.github_terraform.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.terraform_state_read_statements, local.terraform_state_write_statements, [
      # ---- Broad within a service (see the header) ---------------------------
      {
        # VPC, subnets, IGW, NAT, EIP, route tables, security groups. ENIs of
        # Lambda/ECS/RDS/VPC link are released on destroy through these too.
        Sid      = "Ec2InRegion"
        Effect   = "Allow"
        Action   = ["ec2:*"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = var.region }
        }
      },
      {
        # HTTP API, stage, VPC link, integration, routes, authorizer: ARNs are
        # generated IDs (/apis/<id>), so no name scoping is possible.
        Sid    = "ApiGateway"
        Effect = "Allow"
        Action = ["apigateway:*"]
        Resource = [
          "arn:aws:apigateway:${var.region}::/apis",
          "arn:aws:apigateway:${var.region}::/apis/*",
          "arn:aws:apigateway:${var.region}::/vpclinks",
          "arn:aws:apigateway:${var.region}::/vpclinks/*",
          "arn:aws:apigateway:${var.region}::/tags/*",
        ]
      },
      {
        # Distribution and origin access control IDs are generated.
        Sid    = "CloudFront"
        Effect = "Allow"
        Action = ["cloudfront:*"]
        Resource = [
          "arn:aws:cloudfront::${local.account_id}:distribution/*",
          "arn:aws:cloudfront::${local.account_id}:origin-access-control/*",
          "arn:aws:cloudfront::${local.account_id}:cache-policy/*",
        ]
      },
      {
        Sid    = "ReadAnywhere"
        Effect = "Allow"
        Action = [
          "cloudfront:List*",
          "ecs:Describe*",
          "ecs:List*",
          "elasticloadbalancing:Describe*",
          "iam:ListOpenIDConnectProviders",
          "kms:DescribeKey",
          "kms:ListAliases",
          "lambda:GetAccountSettings",
          "lambda:GetEventSourceMapping",
          "lambda:DeleteEventSourceMapping",
          "lambda:ListEventSourceMappings",
          "lambda:ListFunctions",
          "logs:DescribeLogGroups",
          "rds:Describe*",
          "rds:ListTagsForResource",
          "sqs:ListQueues",
          "ssm:DescribeParameters",
        ]
        Resource = "*"
      },
      {
        # Encrypted RDS storage, secrets and the staging bucket use AWS managed
        # keys; the services create grants on the caller's behalf.
        Sid      = "KmsThroughServices"
        Effect   = "Allow"
        Action   = ["kms:CreateGrant", "kms:Decrypt", "kms:GenerateDataKey*"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = [
              "rds.${var.region}.amazonaws.com",
              "secretsmanager.${var.region}.amazonaws.com",
              "s3.${var.region}.amazonaws.com",
              "sqs.${var.region}.amazonaws.com",
            ]
          }
        }
      },

      # ---- Scoped by name ----------------------------------------------------
      {
        Sid      = "Ecr"
        Effect   = "Allow"
        Action   = ["ecr:*"]
        Resource = "arn:aws:ecr:${var.region}:${local.account_id}:repository/${var.project_name}/*"
      },
      {
        Sid    = "S3Buckets"
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = [
          "arn:aws:s3:::${local.name_prefix}-*",
          "arn:aws:s3:::${local.name_prefix}-*/*",
        ]
      },
      {
        Sid    = "Ssm"
        Effect = "Allow"
        Action = [
          "ssm:AddTagsToResource",
          "ssm:DeleteParameter",
          "ssm:DeleteParameters",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:ListTagsForResource",
          "ssm:PutParameter",
          "ssm:RemoveTagsFromResource",
        ]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Sid      = "Secrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:*"]
        Resource = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.project_name}/${var.environment}/*"
      },
      {
        Sid      = "Sqs"
        Effect   = "Allow"
        Action   = ["sqs:*"]
        Resource = "arn:aws:sqs:${var.region}:${local.account_id}:${local.name_prefix}-*"
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = ["logs:*"]
        Resource = [
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/ecs/${local.name_prefix}/*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*",
        ]
      },
      {
        Sid    = "Lambda"
        Effect = "Allow"
        Action = ["lambda:*"]
        Resource = [
          "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.name_prefix}-*",
          "arn:aws:lambda:${var.region}:${local.account_id}:event-source-mapping:*",
        ]
      },
      {
        # Event source mappings are created against "*" and scoped by function.
        Sid      = "LambdaEventSourceMappings"
        Effect   = "Allow"
        Action   = ["lambda:CreateEventSourceMapping"]
        Resource = "*"
        Condition = {
          StringLike = { "lambda:FunctionArn" = "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.name_prefix}-*" }
        }
      },
      {
        Sid    = "Ecs"
        Effect = "Allow"
        Action = ["ecs:*"]
        Resource = [
          "arn:aws:ecs:${var.region}:${local.account_id}:cluster/${local.name_prefix}-*",
          "arn:aws:ecs:${var.region}:${local.account_id}:service/${local.name_prefix}-cluster/*",
          "arn:aws:ecs:${var.region}:${local.account_id}:task-definition/${local.name_prefix}-*",
        ]
      },
      {
        # No resource-level permissions for these.
        Sid      = "EcsTaskDefinitions"
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"]
        Resource = "*"
      },
      {
        Sid    = "LoadBalancer"
        Effect = "Allow"
        Action = ["elasticloadbalancing:*"]
        Resource = [
          "arn:aws:elasticloadbalancing:${var.region}:${local.account_id}:loadbalancer/app/${local.name_prefix}-*/*",
          "arn:aws:elasticloadbalancing:${var.region}:${local.account_id}:listener/app/${local.name_prefix}-*/*",
          "arn:aws:elasticloadbalancing:${var.region}:${local.account_id}:listener-rule/app/${local.name_prefix}-*/*",
          "arn:aws:elasticloadbalancing:${var.region}:${local.account_id}:targetgroup/${local.name_prefix}-*/*",
        ]
      },
      {
        # The instance, its subnet group, and the default parameter/option
        # groups it references. Proxy ARNs are generated (prx-...), and the
        # proxy is disabled in dev.
        Sid    = "Rds"
        Effect = "Allow"
        Action = ["rds:*"]
        Resource = [
          "arn:aws:rds:${var.region}:${local.account_id}:db:${local.name_prefix}-*",
          "arn:aws:rds:${var.region}:${local.account_id}:subgrp:${local.name_prefix}-*",
          "arn:aws:rds:${var.region}:${local.account_id}:snapshot:${local.name_prefix}-*",
          "arn:aws:rds:${var.region}:${local.account_id}:pg:default.*",
          "arn:aws:rds:${var.region}:${local.account_id}:og:default:*",
          "arn:aws:rds:${var.region}:${local.account_id}:db-proxy:*",
          "arn:aws:rds:${var.region}:${local.account_id}:target-group:*",
        ]
      },

      # ---- IAM ---------------------------------------------------------------
      {
        # Roles for ECS tasks, Lambdas, the RDS proxy, and the GitHub roles in
        # this stack (including this one).
        Sid    = "IamRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:ListRolePolicies",
          "iam:ListRoleTags",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = "arn:aws:iam::${local.account_id}:role/${local.name_prefix}-*"
      },
      {
        # Only the managed policies the modules attach.
        Sid      = "IamManagedPolicies"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = "arn:aws:iam::${local.account_id}:role/${local.name_prefix}-*"
        Condition = {
          ArnEquals = {
            "iam:PolicyARN" = [
              "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
              "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            ]
          }
        }
      },
      {
        # Customer-managed policies created by the teardown stack (API and
        # worker runtime). CreatePolicy is authorized against the policy ARN.
        Sid    = "IamCustomerPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyTags",
          "iam:ListPolicyVersions",
          "iam:SetDefaultPolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = "arn:aws:iam::${local.account_id}:policy/${local.name_prefix}-*"
      },
      {
        Sid      = "IamAttachCustomerPolicies"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = "arn:aws:iam::${local.account_id}:role/${local.name_prefix}-*"
        Condition = {
          StringLike = {
            "iam:PolicyARN" = "arn:aws:iam::${local.account_id}:policy/${local.name_prefix}-*"
          }
        }
      },
      {
        Sid      = "IamPassRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "arn:aws:iam::${local.account_id}:role/${local.name_prefix}-*"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = ["ecs-tasks.amazonaws.com", "lambda.amazonaws.com", "rds.amazonaws.com"]
          }
        }
      },
      {
        Sid    = "IamGitHubOidcProvider"
        Effect = "Allow"
        Action = [
          "iam:AddClientIDToOpenIDConnectProvider",
          "iam:CreateOpenIDConnectProvider",
          "iam:DeleteOpenIDConnectProvider",
          "iam:GetOpenIDConnectProvider",
          "iam:RemoveClientIDFromOpenIDConnectProvider",
          "iam:TagOpenIDConnectProvider",
          "iam:UntagOpenIDConnectProvider",
          "iam:UpdateOpenIDConnectProviderThumbprint",
        ]
        Resource = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
      },
      {
        # First use of ECS, ELB, RDS or API Gateway VPC links in an account.
        Sid      = "IamServiceLinkedRoles"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/*"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = [
              "ecs.amazonaws.com",
              "elasticloadbalancing.amazonaws.com",
              "rds.amazonaws.com",
              "ops.apigateway.amazonaws.com",
            ]
          }
        }
      },
    ])
  })
}

# =============================================================================
# SSM — so the role ARNs can be looked up instead of copied around
# =============================================================================
resource "aws_ssm_parameter" "github_terraform_role_arn" {
  name        = "${local.ssm_prefix}/github_terraform_role_arn"
  description = "IAM role GitHub Actions assumes to apply dev-base and dev (AWS_TERRAFORM_ROLE_ARN)."
  type        = "String"
  value       = aws_iam_role.github_terraform.arn
}

resource "aws_ssm_parameter" "github_terraform_plan_role_arn" {
  name        = "${local.ssm_prefix}/github_terraform_plan_role_arn"
  description = "IAM role GitHub Actions assumes to plan dev-base and dev (AWS_TERRAFORM_PLAN_ROLE_ARN)."
  type        = "String"
  value       = aws_iam_role.github_terraform_plan.arn
}
