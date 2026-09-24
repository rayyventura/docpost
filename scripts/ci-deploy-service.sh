#!/bin/bash
# Creates the service database if needed, migrates it, and rolls the ECS service
# onto the image the workflow just pushed.
set -euo pipefail

SERVICE_NAME="${1:?service name}"
IMAGE="${2:?image uri}"
CLUSTER="${ECS_CLUSTER:-docpost-dev-cluster}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
REGION="${AWS_REGION:-us-east-1}"
SERVICE="docpost-${ENVIRONMENT}-${SERVICE_NAME}"
FAMILY="$SERVICE"

case "$SERVICE_NAME" in
  auth)
    DB_NAME=docpost_auth
    DB_USER=auth_service
    SECRET_ID="docpost/${ENVIRONMENT}/rds/auth_service"
    WORKSPACE=@docpost/auth
    ;;
  platform)
    DB_NAME=docpost_platform
    DB_USER=platform_service
    SECRET_ID="docpost/${ENVIRONMENT}/rds/platform_service"
    WORKSPACE=@docpost/platform
    ;;
  docpost-api)
    DB_NAME=docpost_api
    DB_USER=docpost_service
    SECRET_ID="docpost/${ENVIRONMENT}/rds/docpost_service"
    WORKSPACE=@docpost/docpost-api
    ;;
  *)
    echo "Unknown service: $SERVICE_NAME" >&2
    exit 1
    ;;
esac

RDS_HOST="$(aws rds describe-db-instances \
  --region "$REGION" \
  --db-instance-identifier "docpost-${ENVIRONMENT}-postgres" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"

NET_JSON="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
SUBNETS="$(echo "$NET_JSON" | jq -r '.subnets | join(",")')"
SECURITY_GROUPS="$(echo "$NET_JSON" | jq -r '.securityGroups | join(",")')"

run_task() {
  local task_arn="$1"
  local overrides="$2"
  local task_id
  task_id="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
    --task-definition "$task_arn" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUPS],assignPublicIp=DISABLED}" \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' --output text)"
  echo "Started $task_id"
  aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$task_id"
  local code
  code="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_id" \
    --query 'tasks[0].containers[0].exitCode' --output text)"
  if [ "$code" != "0" ]; then
    echo "Task $task_id exited $code" >&2
    aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_id" \
      --query 'tasks[0].containers[0].reason' --output text >&2
    exit 1
  fi
}

CURRENT="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)"
if [[ "$CURRENT" != postgres://* && "$CURRENT" != postgresql://* ]]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${RDS_HOST}:5432/${DB_NAME}"
  MASTER="$(aws secretsmanager get-secret-value --region "$REGION" \
    --secret-id "docpost/${ENVIRONMENT}/rds/master-password" --query SecretString --output text)"
  EXEC_ROLE="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$FAMILY" \
    --query 'taskDefinition.executionRoleArn' --output text)"

  SQL="DO \$\$ BEGIN CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'; END \$\$; SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\\gexec GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

  BOOTSTRAP_JSON="$(mktemp)"
  jq -n \
    --arg family "docpost-${ENVIRONMENT}-db-bootstrap" \
    --arg exec "$EXEC_ROLE" \
    --arg host "$RDS_HOST" \
    --arg master "$MASTER" \
    --arg sql "$SQL" \
    --arg region "$REGION" \
    --arg group "/ecs/docpost-${ENVIRONMENT}/auth" \
    '{
      family: $family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      executionRoleArn: $exec,
      containerDefinitions: [{
        name: "bootstrap",
        image: "public.ecr.aws/docker/library/postgres:16",
        essential: true,
        command: ["bash", "-c", "export PGPASSWORD=\"$MASTER\"; psql -h \"$PGHOST\" -U docpost_admin -d postgres -v ON_ERROR_STOP=1 -c \"$SQL\""],
        environment: [
          {name: "PGHOST", value: $host},
          {name: "MASTER", value: $master},
          {name: "SQL", value: $sql}
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": $group,
            "awslogs-region": $region,
            "awslogs-stream-prefix": "bootstrap"
          }
        }
      }]
    }' > "$BOOTSTRAP_JSON"

  # The shell inside the container must expand MASTER and SQL, so write the command after jq.
  python3 - "$BOOTSTRAP_JSON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    doc = json.load(f)
doc["containerDefinitions"][0]["command"] = [
    "bash", "-c",
    'psql -h "$PGHOST" -U docpost_admin -d postgres -v ON_ERROR_STOP=1 <<SQL\n'"$SQL"'\nSQL'
]
# Password is passed as an env var named PGPASSWORD by rewriting environment.
env = {item["name"]: item["value"] for item in doc["containerDefinitions"][0]["environment"]}
doc["containerDefinitions"][0]["environment"] = [
    {"name": "PGHOST", "value": env["PGHOST"]},
    {"name": "PGPASSWORD", "value": env["MASTER"]},
    {"name": "SQL", "value": env["SQL"]},
]
doc["containerDefinitions"][0]["command"] = [
    "bash", "-c",
    'psql -h "$PGHOST" -U docpost_admin -d postgres -v ON_ERROR_STOP=1 <<SQL\n$SQL\nSQL'
]
with open(path, "w") as f:
    json.dump(doc, f)
PY

  BOOTSTRAP_ARN="$(aws ecs register-task-definition --region "$REGION" --cli-input-json "file://${BOOTSTRAP_JSON}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)"
  rm -f "$BOOTSTRAP_JSON"
  run_task "$BOOTSTRAP_ARN" '{"containerOverrides":[{"name":"bootstrap"}]}'
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" --secret-string "$DATABASE_URL" >/dev/null
fi

TASK_DEF="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$FAMILY" --query 'taskDefinition' --output json)"
NEW_TASK_DEF="$(echo "$TASK_DEF" | jq --arg IMAGE "$IMAGE" \
  '.containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)')"
NEW_REVISION="$(aws ecs register-task-definition --region "$REGION" --cli-input-json "$NEW_TASK_DEF" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

run_task "$NEW_REVISION" "$(jq -n --arg name "$SERVICE_NAME" --arg ws "$WORKSPACE" \
  '{containerOverrides:[{name:$name, command:["npm","run","db:migrate","--workspace",$ws]}]}')"

aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_REVISION" --desired-count 1 \
  --query 'service.taskDefinition' --output text

aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo "Deployed $NEW_REVISION"
