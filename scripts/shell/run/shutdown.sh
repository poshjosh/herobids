#!/usr/bin/env bash

set -euo pipefail

# EXTRA_COMPOSE_FILES (optional): additional `-f <file>` overlays to include so
# teardown matches the file set used at bring-up (e.g. docker/xstack.override.yml
# for the cross-stack runner). Empty by default → standalone teardown unchanged.
# shellcheck disable=SC2086
COMPOSE="docker compose -f docker-compose.yaml -f docker-compose.dev.yaml ${EXTRA_COMPOSE_FILES:-}"

# 1. Gracefully stop the worker first so it releases its DB/Redis connections
#    and disconnects from the project network before we try to remove it.
$COMPOSE stop worker 2>/dev/null || true

# 2. Stop and remove dynamically-spawned agent containers (by name prefix).
#    These are created directly via the Docker API and are invisible to compose,
#    so --remove-orphans will never catch them.
docker ps -aq --filter "name=herobids-agent-" | xargs -r docker rm -f

# 3. Remove any stale herobids-worker / herobids-agent containers that survived
#    under a random Docker name (e.g. from manual `docker run` during debugging).
#    NOTE: multiple --filter flags are ANDed by Docker, so each image needs its
#    own command.
docker ps -aq --filter "ancestor=herobids-worker"       | xargs -r docker rm -f
docker ps -aq --filter "ancestor=herobids-agent:latest" | xargs -r docker rm -f

# 4. Force-disconnect anything still attached to the project network so that
#    `compose down` can remove the network cleanly without a "still in use" error.
NETWORK="herobids_default"
if docker network inspect "$NETWORK" &>/dev/null; then
  docker network inspect "$NETWORK" \
    --format '{{range .Containers}}{{.Name}} {{end}}' \
    | tr ' ' '\n' | grep -v '^$' \
    | xargs -r -I{} docker network disconnect -f "$NETWORK" {} 2>/dev/null || true
fi

# 5. Tear down the compose stack, removing named volumes and orphaned containers.
$COMPOSE down -v --remove-orphans
