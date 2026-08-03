#!/bin/sh
# Ensure the data volume is writable by the app user, then drop privileges.
# A fresh named volume is root-owned, so SQLite cannot create wiki.db as `node`.
set -e

DATA_DIR="$(dirname "${WIKIFLIP_DB:-/app/data/wiki.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$0" "$@"
fi

# Re-check as node so a mis-mounted volume fails with a clear message.
if [ ! -w "$DATA_DIR" ]; then
  echo "WikiFlip NG: data directory is not writable: $DATA_DIR" >&2
  echo "  Mount a volume on /app/data (or set WIKIFLIP_DB to a writable path)." >&2
  exit 1
fi

exec "$@"
