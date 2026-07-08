#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
MIGRATIONS="$REPOSITORY_ROOT/packages/agent-server/migrations"

cd "$REPOSITORY_ROOT"
for migration in "$MIGRATIONS"/*.sql; do
  echo "Applying $(basename "$migration")"
  docker compose exec -T mysql mysql \
    --user=root \
    --password=root-dev-password \
    agent_platform < "$migration"
done
