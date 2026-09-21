#!/bin/bash
# -----------------------------------------------------------------------------
# Database Bootstrap
# Runs as a one-off ECS task to create logical databases and per-service roles.
# Called from the deploy pipeline, NOT from terraform apply (ADR-020).
# -----------------------------------------------------------------------------
set -euo pipefail

echo "Database bootstrap - creates logical databases and per-service roles"
echo "Usage: ./scripts/db-bootstrap.sh <cluster-name> <task-definition-arn>"
echo ""

if [ $# -lt 2 ]; then
  echo "Error: missing required arguments"
  echo "  cluster-name:        ECS cluster name or ARN"
  echo "  task-definition-arn: ARN of the bootstrap task definition"
  exit 1
fi

CLUSTER_NAME="$1"
TASK_DEFINITION_ARN="$2"

echo "Cluster:         ${CLUSTER_NAME}"
echo "Task Definition: ${TASK_DEFINITION_ARN}"
echo ""
echo "Placeholder — actual implementation depends on the bootstrap task definition."
echo "The bootstrap task should:"
echo "  1. Connect to the RDS instance using master credentials"
echo "  2. Create logical databases: auth_service, platform_service, docpost_service"
echo "  3. Create per-service roles with least-privilege access"
echo "  4. Store credentials in Secrets Manager"
