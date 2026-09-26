#!/bin/bash
# -----------------------------------------------------------------------------
# Runs INSIDE the <project>-<env>-db-bootstrap ECS task (postgres image).
# Terraform embeds this file as the container command; scripts/db-bootstrap.sh
# starts the task. Do not run it on a laptop.
#
# Input (injected by ECS):
#   PGHOST, PGPORT, PGUSER  master connection
#   PGPASSWORD              master password (secret)
#   *_DATABASE_URL          one per service (secret), for example
#                           postgresql://auth_service:<pw>@<host>:5432/docpost_auth?sslmode=no-verify
#
# For every URL this makes sure that:
#   - the login role exists, has no extra attributes, and has the URL's password
#   - the database exists and is owned by that role
#   - only that role (and the master, through membership) can connect to it
# Every statement is conditional or repeatable, so re-running is safe.
# A value that is not a database URL yet (the Terraform placeholder) is skipped.
# -----------------------------------------------------------------------------
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

export PGDATABASE=postgres
# RDS for PostgreSQL 16 sets rds.force_ssl=1.
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=15

ensure_database() {
  local label="$1"
  local url="$2"

  case "$url" in
    postgres://*|postgresql://*) ;;
    *)
      echo "${label}: not a database URL yet, skipping"
      return 0
      ;;
  esac

  local rest="${url#*://}"
  local creds="${rest%%@*}"
  local db_user="${creds%%:*}"
  local db_password="${creds#*:}"
  local db_name="${rest##*/}"
  db_name="${db_name%%\?*}"

  if [ -z "$db_user" ] || [ -z "$db_password" ] || [ -z "$db_name" ] || [ "$creds" = "$db_user" ]; then
    echo "${label}: could not read user, password and database from the URL" >&2
    return 1
  fi

  echo "${label}: role ${db_user}, database ${db_name}"

  # psql variables are quoted by format(%I / %L), so nothing here is spliced
  # into SQL by the shell. -q keeps the password out of the task logs.
  psql -X -q -v ON_ERROR_STOP=1 \
    -v db_user="$db_user" \
    -v db_password="$db_password" \
    -v db_name="$db_name" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'db_user')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'db_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', :'db_user', :'db_password') \gexec

-- The master must be able to SET ROLE to the owner to create or hand over the database.
SELECT format('GRANT %I TO CURRENT_USER', :'db_user')
 WHERE NOT pg_has_role(CURRENT_USER, :'db_user', 'SET') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name') \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_user') \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec

SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db_name', :'db_user') \gexec
SQL
}

found=0
for var in $(compgen -A variable | grep -E '_DATABASE_URL$' | sort); do
  found=1
  ensure_database "$var" "${!var}"
done

if [ "$found" = 0 ]; then
  echo "No *_DATABASE_URL variables were provided" >&2
  exit 1
fi

echo "Database bootstrap finished"
