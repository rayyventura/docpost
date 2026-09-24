# =============================================================================
# Dev Environment — Variable Values
# =============================================================================

project_name = "docpost"
environment  = "dev"
region       = "us-east-1"

# Network
vpc_cidr = "10.0.0.0/16"

# RDS — small instance for dev
rds_instance_class = "db.t4g.micro"
# rds_master_password — set via TF_VAR_rds_master_password or -var flag

# ECS — minimal for dev
ecs_cpu           = 256
ecs_memory        = 512
ecs_desired_count = 1

# SPA CORS — permissive in dev
spa_cors_origins = ["*"]
