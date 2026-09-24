# =============================================================================
# Prod Environment — Variable Values
# =============================================================================

project_name = "docpost"
environment  = "prod"
region       = "us-east-1"

# Network
vpc_cidr = "10.0.0.0/16"

# RDS — same size as dev for a learning project; structure supports upgrading
rds_instance_class = "db.t4g.micro"
rds_multi_az       = false
# rds_master_password — set via TF_VAR_rds_master_password or -var flag

# ECS — 2 tasks per service for availability
ecs_cpu           = 256
ecs_memory        = 512
ecs_desired_count = 2

# SPA CORS — restrict in prod to the CloudFront domain
# Update this after first deploy with the actual CloudFront domain
spa_cors_origins = ["*"]
