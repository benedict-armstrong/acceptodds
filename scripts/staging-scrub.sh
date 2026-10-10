#!/usr/bin/env bash
# Remove production credentials from staging's copy of the data
# (scripts/staging-scrub.sql). Hardcoded to the staging container: production's
# database has the same name, so nothing but the container tells them apart.
set -euo pipefail
cd "$(dirname "$0")"
container=acceptodds-staging-postgres-1
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
if [ "$project" != acceptodds-staging ]; then
  echo "refusing: $container belongs to compose project '$project', not acceptodds-staging" >&2
  exit 1
fi
docker exec -i "$container" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < staging-scrub.sql
