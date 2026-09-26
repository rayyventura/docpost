#!/bin/bash
# Rolls an ECS service onto the image the workflow just pushed:
#   1. database, role and credentials exist (scripts/db-bootstrap.sh roles),
#      only when the service secret does not hold a URL for this instance yet
#   2. register a task definition revision with the new image
#   3. migrate with that revision (scripts/db-migrate.sh)
#   4. update the service and wait until it is stable
set -euo pipefail

SERVICE_NAME="${1:?service name}"
IMAGE="${2:?image uri}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/lib/dev-db.sh"

service_config "$SERVICE_NAME"
load_network
load_rds
SERVICE="${ECS_SERVICE:-$(ssm_get "ecs_service/${SERVICE_NAME}")}"

# A fresh or rebuilt environment still has Terraform's placeholder in the
# secret. The bootstrap is the only place that creates roles and databases.
if [ "$(secret_state)" != "ok" ]; then
  echo "${SERVICE_NAME}: ${SECRET_ID} is not ready; running the database bootstrap"
  bash "${SCRIPT_DIR}/db-bootstrap.sh" roles "$SERVICE_NAME"
fi

TASK_DEF="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$FAMILY" --query 'taskDefinition' --output json)"
NEW_TASK_DEF="$(echo "$TASK_DEF" | jq --arg IMAGE "$IMAGE" \
  '.containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)')"
NEW_REVISION="$(aws ecs register-task-definition --region "$REGION" --cli-input-json "$NEW_TASK_DEF" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

bash "${SCRIPT_DIR}/db-migrate.sh" "$SERVICE_NAME" "$NEW_REVISION"

aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_REVISION" --desired-count 1 \
  --query 'service.taskDefinition' --output text

aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo "Deployed $NEW_REVISION"
