#!/bin/bash
# -----------------------------------------------------------------------------
# Database Bootstrap
# Prepares the RDS instance of a freshly applied environment. Runs from CI
# (the deploy role), never from terraform apply (ADR-020). RDS is private, so
# every step that talks to Postgres is a one-off Fargate task in the VPC.
#
# Usage: scripts/db-bootstrap.sh [all|roles|migrate|seed] [service ...]
#   roles    Make sure each service secret holds a DATABASE_URL for the
#            current instance (generating a password when it does not), then
#            run the <project>-<env>-db-bootstrap task, which creates or
#            updates the roles and databases to match the secrets.
#   migrate  scripts/db-migrate.sh for each service whose image is in ECR.
#   seed     dev only: seed users (auth) and, when empty, teams (platform).
#   all      roles, migrate, seed (default).
#   service  auth, platform, docpost-api (default: all three).
#
# Every step is safe to re-run:
#   - a secret that already holds a URL for this instance keeps its password
#   - the bootstrap task only creates what is missing and re-applies the
#     password from the secret
#   - migrations are Drizzle migrate/push
#   - the auth seed skips existing users; the platform seed (which deletes
#     and recreates all teams) only runs while the teams table is empty
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/lib/dev-db.sh"

STEP="${1:-all}"
if [ $# -gt 0 ]; then shift; fi
SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${ALL_SERVICES[@]}")
fi

case "$STEP" in
  all|roles|migrate|seed) ;;
  *)
    echo "Usage: scripts/db-bootstrap.sh [all|roles|migrate|seed] [service ...]" >&2
    exit 1
    ;;
esac

load_network
echo "Environment: ${ENVIRONMENT}  Cluster: ${CLUSTER}  Services: ${SERVICES[*]}"

# Services whose credentials changed in this run; their running tasks still
# hold the old DATABASE_URL.
CHANGED=()

step_roles() {
  load_rds
  local svc state password
  for svc in "${SERVICES[@]}"; do
    service_config "$svc"
    state="$(secret_state)"
    case "$state" in
      ok)
        echo "${svc}: ${SECRET_ID} already holds a URL for ${RDS_HOST}"
        ;;
      rewrite\ *)
        password="${state#rewrite }"
        aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
          --secret-string "$(database_url "$password")" >/dev/null
        echo "${svc}: normalised the URL in ${SECRET_ID} (password unchanged)"
        CHANGED+=("$svc")
        ;;
      new)
        password="$(openssl rand -hex 24)"
        mask "$password"
        aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
          --secret-string "$(database_url "$password")" >/dev/null
        echo "${svc}: wrote new credentials to ${SECRET_ID}"
        CHANGED+=("$svc")
        ;;
    esac
  done

  # The task reads every service secret when it starts, so it also repairs a
  # role whose database was rebuilt while its secret stayed valid.
  run_oneoff_task "$(ssm_get db_bootstrap/task_family)" '{"containerOverrides":[{"name":"bootstrap"}]}' "db-bootstrap"
}

# Services that were migrated in this run (seed needs auth and platform).
MIGRATED=()

step_migrate() {
  local svc code
  for svc in "${SERVICES[@]}"; do
    code=0
    bash "${SCRIPT_DIR}/db-migrate.sh" "$svc" || code=$?
    case "$code" in
      0) MIGRATED+=("$svc") ;;
      3)
        if [ "$STEP" = "migrate" ]; then
          exit 3
        fi
        echo "::warning::${svc}: no image in ECR yet, skipping its migration. The deploy workflow migrates it."
        ;;
      *) exit "$code" ;;
    esac
  done
}

contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

step_seed() {
  if [ "$ENVIRONMENT" != "dev" ]; then
    echo "Seeding is dev only; skipping (${ENVIRONMENT})"
    return 0
  fi

  if contains auth "${SERVICES[@]}"; then
    service_config auth
    if [ "$STEP" = "all" ] && ! contains auth "${MIGRATED[@]+"${MIGRATED[@]}"}"; then
      echo "::warning::auth was not migrated in this run, so it is not seeded. Re-run with: scripts/db-bootstrap.sh seed"
    else
      # Inserts the seed users and the delivery-worker client; existing rows are kept.
      run_oneoff_task "$FAMILY" "$(jq -n --arg name "$CONTAINER" --arg ws "$WORKSPACE" \
        '{containerOverrides: [{name: $name, command: ["bash", "-c", ("npm run db:seed --workspace=" + $ws)]}]}')" \
        "seed-auth"
    fi
  fi

  if contains platform "${SERVICES[@]}"; then
    service_config platform
    if [ "$STEP" = "all" ] && ! contains platform "${MIGRATED[@]+"${MIGRATED[@]}"}"; then
      echo "::warning::platform was not migrated in this run, so it is not seeded. Re-run with: scripts/db-bootstrap.sh seed"
    else
      # services/platform/src/db/seed.ts deletes every team, binder, folder and
      # document before inserting its sample data, so only run it on an empty
      # database. Its memberships already cover the seeded auth users.
      local count_js='const pg=require("pg");const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("SELECT count(*)::int AS n FROM teams")).then(r=>{console.log(r.rows[0].n);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
      local cmd="set -e
teams=\$(node -e '${count_js}')
if [ \"\$teams\" = 0 ]; then
  npm run db:seed --workspace=${WORKSPACE}
else
  echo \"platform already has \$teams teams; not reseeding\"
fi"
      run_oneoff_task "$FAMILY" "$(jq -n --arg name "$CONTAINER" --arg cmd "$cmd" \
        '{containerOverrides: [{name: $name, command: ["bash", "-c", $cmd]}]}')" \
        "seed-platform"
    fi
  fi

  echo "Dev sign-in users (services/auth/src/db/seed.ts): alice@example.com, bob@example.com, carol@example.com, rayyventura@gmail.com"
}

# Restart services whose credentials changed so their tasks read the new secret.
restart_changed() {
  local svc service
  for svc in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    contains "$svc" "${MIGRATED[@]+"${MIGRATED[@]}"}" || continue
    service="$(ssm_get "ecs_service/${svc}")"
    aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$service" \
      --force-new-deployment --query 'service.serviceName' --output text >/dev/null
    echo "${svc}: credentials changed; started a new deployment of ${service}"
  done
}

case "$STEP" in
  roles)   step_roles ;;
  migrate) step_migrate ;;
  seed)    step_seed ;;
  all)
    step_roles
    step_migrate
    step_seed
    restart_changed
    ;;
esac

echo "Database bootstrap (${STEP}) finished"
