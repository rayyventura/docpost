# =============================================================================
# Dev Base — Variable Values
# =============================================================================

project_name = "docpost"
environment  = "dev"
region       = "us-east-1"

# SPA CORS — permissive in dev
spa_cors_origins = ["*"]

# Dev secrets can be recreated right after a destroy
secret_recovery_window_days = 0
