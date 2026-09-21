#!/bin/bash
# -----------------------------------------------------------------------------
# Database Migration Runner
# Runs Drizzle migrations for a specific service as a one-off ECS task.
# -----------------------------------------------------------------------------
set -euo pipefail

echo "Database migration runner"
echo "Usage: ./scripts/db-migrate.sh <cluster-name> <service-name>"
echo ""

if [ $# -lt 2 ]; then
  echo "Error: missing required arguments"
  echo "  cluster-name: ECS cluster name or ARN"
  echo "  service-name: one of auth, platform, docpost-api"
  exit 1
fi

CLUSTER_NAME="$1"
SERVICE_NAME="$2"

echo "Cluster: ${CLUSTER_NAME}"
echo "Service: ${SERVICE_NAME}"
echo ""
echo "Placeholder — actual implementation depends on the migrate task definition."
echo "The migration task should:"
echo "  1. Pull the latest service image"
echo "  2. Run 'npx drizzle-kit migrate' with the service's database credentials"
echo "  3. Report success/failure"
