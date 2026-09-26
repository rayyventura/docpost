#!/bin/bash
# -----------------------------------------------------------------------------
# Shared helpers for the database scripts that run from CI:
#   scripts/db-bootstrap.sh, scripts/db-migrate.sh, scripts/ci-deploy-service.sh
# Source it; do not run it.
#
# Environment values come from Parameter Store (/<project>/<env>/...), written
# by infra/envs/dev-base and infra/envs/dev. A missing teardown-layer value
# means infra/envs/dev is not applied.
# -----------------------------------------------------------------------------

PROJECT="${PROJECT:-docpost}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
REGION="${AWS_REGION:-us-east-1}"
SSM_PREFIX="/${PROJECT}/${ENVIRONMENT}"

# ssm_get <name>  ->  value of /<project>/<env>/<name>
ssm_get() {
  local value
  if ! value="$(aws ssm get-parameter --region "$REGION" --name "${SSM_PREFIX}/$1" \
    --query 'Parameter.Value' --output text 2>/dev/null)"; then
    echo "Parameter ${SSM_PREFIX}/$1 is missing. Is infra/envs/${ENVIRONMENT} applied?" >&2
    return 1
  fi
  printf '%s' "$value"
}

# Hide a value in GitHub Actions logs. Written to stderr so it also works
# inside $(...); the runner reads workflow commands from both streams.
mask() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::$1" >&2
  fi
}

# service_config <auth|platform|docpost-api>
# Sets DB_NAME, DB_USER, SECRET_ID, WORKSPACE, SERVICE_DIR, FAMILY, CONTAINER.
service_config() {
  case "$1" in
    auth)
      DB_NAME=docpost_auth
      DB_USER=auth_service
      WORKSPACE=@docpost/auth
      SERVICE_DIR=services/auth
      ;;
    platform)
      DB_NAME=docpost_platform
      DB_USER=platform_service
      WORKSPACE=@docpost/platform
      SERVICE_DIR=services/platform
      ;;
    docpost-api)
      DB_NAME=docpost_api
      DB_USER=docpost_service
      WORKSPACE=@docpost/docpost-api
      SERVICE_DIR=services/docpost-api
      ;;
    *)
      echo "Unknown service: $1 (expected auth, platform or docpost-api)" >&2
      return 1
      ;;
  esac
  SECRET_ID="${PROJECT}/${ENVIRONMENT}/rds/${DB_USER}"
  FAMILY="${PROJECT}-${ENVIRONMENT}-$1"
  CONTAINER="$1"
}

ALL_SERVICES=(auth platform docpost-api)

# load_network  ->  CLUSTER, SUBNETS, DB_TASK_SG
load_network() {
  CLUSTER="${ECS_CLUSTER:-$(ssm_get ecs_cluster)}"
  SUBNETS="$(ssm_get private_subnet_ids)"
  DB_TASK_SG="$(ssm_get db_bootstrap/security_group_id)"
}

# load_rds  ->  RDS_HOST, RDS_PORT
load_rds() {
  local id
  id="$(ssm_get rds_instance_identifier)"
  read -r RDS_HOST RDS_PORT < <(aws rds describe-db-instances --region "$REGION" \
    --db-instance-identifier "$id" \
    --query 'DBInstances[0].Endpoint.[Address,Port]' --output text)
  if [ -z "$RDS_HOST" ] || [ "$RDS_HOST" = "None" ]; then
    echo "RDS instance $id has no endpoint yet" >&2
    return 1
  fi
}

# database_url <password>  ->  the canonical DATABASE_URL for the current service.
# RDS for PostgreSQL 16 forces TLS. node-postgres reads sslmode=no-verify as
# "encrypt, do not verify the RDS CA", which Node does not trust by default.
database_url() {
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=no-verify' "$DB_USER" "$1" "$RDS_HOST" "$RDS_PORT" "$DB_NAME"
}

# secret_state  ->  prints "ok", "rewrite <password>" or "new"
# (call service_config and load_rds first). The password is masked.
secret_state() {
  local current host_re
  current="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
    --query SecretString --output text 2>/dev/null || true)"
  host_re="${RDS_HOST//./\\.}"
  if [[ "$current" =~ ^postgres(ql)?://${DB_USER}:([^@/]+)@${host_re}:${RDS_PORT}/${DB_NAME}(\?.*)?$ ]]; then
    local password="${BASH_REMATCH[2]}"
    mask "$password"
    if [ "$current" = "$(database_url "$password")" ]; then
      echo "ok"
    else
      echo "rewrite $password"
    fi
  else
    echo "new"
  fi
}

# task_log_tail <task-arn> <task-definition>  ->  last log lines of the first container
task_log_tail() {
  local task_arn="$1" task_def="$2" opts group prefix container
  opts="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$task_def" \
    --query 'taskDefinition.containerDefinitions[0].[name,logConfiguration.options."awslogs-group",logConfiguration.options."awslogs-stream-prefix"]' \
    --output text 2>/dev/null)" || return 0
  read -r container group prefix <<<"$opts"
  echo "---- last log lines (${group}) ----" >&2
  aws logs get-log-events --region "$REGION" --log-group-name "$group" \
    --log-stream-name "${prefix}/${container}/${task_arn##*/}" --limit 40 \
    --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' >&2 || true
  echo "-----------------------------------" >&2
}

# run_oneoff_task <task-definition> <overrides-json> <label>
# Runs a Fargate task in the private subnets with the DB task security group,
# waits for it to stop, and fails unless every container exited 0.
run_oneoff_task() {
  local task_def="$1" overrides="$2" label="$3" out task_arn codes reason
  out="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
    --task-definition "$task_def" \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${DB_TASK_SG}],assignPublicIp=DISABLED}" \
    --overrides "$overrides" \
    --started-by "ci-${label}" \
    --output json)"
  task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$out")"
  if [ -z "$task_arn" ]; then
    echo "${label}: run-task failed: $(jq -c '.failures' <<<"$out")" >&2
    return 1
  fi
  echo "${label}: started ${task_arn##*/}"

  # The CLI waiter gives up after 10 minutes; keep waiting up to 30.
  local i
  for i in 1 2 3; do
    if aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" 2>/dev/null; then
      break
    fi
    if [ "$i" = 3 ]; then
      echo "${label}: task did not stop within 30 minutes" >&2
      return 1
    fi
  done

  codes="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[].exitCode' --output text)"
  reason="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' --output text)"
  for code in $codes; do
    if [ "$code" != "0" ]; then
      echo "${label}: task exited ${codes} (${reason})" >&2
      task_log_tail "$task_arn" "$task_def"
      return 1
    fi
  done
  if [ -z "$codes" ] || [ "$codes" = "None" ]; then
    echo "${label}: container never ran (${reason})" >&2
    return 1
  fi
  echo "${label}: done"
}

# image_available <task-definition>  ->  0 when its first container image can be pulled
# (only checks images in this project's ECR repositories; anything else is assumed present).
image_available() {
  local image repo tag
  image="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$1" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text)"
  case "$image" in
    *.dkr.ecr.*.amazonaws.com/"${PROJECT}"/*) ;;
    *) return 0 ;;
  esac
  repo="${image#*.amazonaws.com/}"
  tag="${repo##*:}"
  repo="${repo%:*}"
  aws ecr describe-images --region "$REGION" --repository-name "$repo" \
    --image-ids "imageTag=${tag}" >/dev/null 2>&1
}
