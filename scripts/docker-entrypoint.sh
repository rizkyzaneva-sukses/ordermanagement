#!/bin/sh
#
# Chooses which process this container runs, based on PROCESS_ROLE.
#
# The API and the background worker share one image and one codebase — they
# differ only in which entrypoint they execute. Selecting that with an
# environment variable rather than a command override keeps both services
# configurable from the same place, which matters on hosts where overriding the
# container command is awkward or hidden.
#
#   PROCESS_ROLE=api     (default) → run migrations, then serve HTTP
#   PROCESS_ROLE=worker            → consume the BullMQ queues, no HTTP
#
# Only the api role migrates: two containers racing `prisma migrate deploy`
# on boot is a good way to deadlock a deploy.

set -e

ROLE="${PROCESS_ROLE:-api}"

case "$ROLE" in
  worker)
    echo "[entrypoint] role=worker — starting queue consumers (no HTTP, no migrations)"
    exec node src/worker.js
    ;;

  api)
    echo "[entrypoint] role=api — applying database migrations"
    npx prisma migrate deploy
    echo "[entrypoint] role=api — starting HTTP server"
    exec node src/server.js
    ;;

  *)
    echo "[entrypoint] ERROR: unknown PROCESS_ROLE '$ROLE' (expected 'api' or 'worker')" >&2
    exit 1
    ;;
esac
