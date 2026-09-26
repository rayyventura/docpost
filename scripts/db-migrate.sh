#!/bin/bash
# -----------------------------------------------------------------------------
# Database Migration Runner
# Runs a service's Drizzle schema changes as a one-off ECS task, using the
# service's own image and DATABASE_URL secret, inside the VPC.
#
# Usage: scripts/db-migrate.sh <auth|platform|docpost-api> [task-definition]
#   task-definition  family, family:revision or ARN; defaults to the latest
#                    revision of <project>-<env>-<service>.
#
# With generated migrations (<service>/migrations or <service>/drizzle
# meta/_journal.json) it runs `drizzle-kit migrate`. The services have no
# generated migrations yet, so in dev it falls back to `drizzle-kit push
# --force`, the same thing scripts/seed-db.mjs does locally. Any other
# environment refuses to push.
#
# Exit codes: 0 migrated, 3 the image is not in ECR yet, 1 anything else.
# -----------------------------------------------------------------------------
set -euo pipefail

source "$(dirname "$0")/lib/dev-db.sh"

SERVICE_NAME="${1:?usage: db-migrate.sh <auth|platform|docpost-api> [task-definition]}"
service_config "$SERVICE_NAME"
TASK_DEF="${2:-$FAMILY}"

load_network

if ! image_available "$TASK_DEF"; then
  echo "${SERVICE_NAME}: the image in ${TASK_DEF} is not in ECR yet; deploy the service first" >&2
  exit 3
fi

ALLOW_PUSH=false
if [ "$ENVIRONMENT" = "dev" ]; then
  ALLOW_PUSH=true
fi

MIGRATE_CMD="set -e
if [ -f ${SERVICE_DIR}/migrations/meta/_journal.json ] || [ -f ${SERVICE_DIR}/drizzle/meta/_journal.json ]; then
  npm run db:migrate --workspace=${WORKSPACE}
elif [ ${ALLOW_PUSH} = true ]; then
  echo 'No generated migrations; syncing the schema with drizzle-kit push (dev only)'
  npm run db:push --workspace=${WORKSPACE} -- --force
else
  echo 'No generated migrations and push is dev only; run drizzle-kit generate and commit the result' >&2
  exit 1
fi"

OVERRIDES="$(jq -n --arg name "$CONTAINER" --arg cmd "$MIGRATE_CMD" \
  '{containerOverrides: [{name: $name, command: ["bash", "-c", $cmd]}]}')"

run_oneoff_task "$TASK_DEF" "$OVERRIDES" "migrate-${SERVICE_NAME}"
