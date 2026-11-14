#!/bin/sh
# Starts the app as the unprivileged "node" user. A host's persistent disk (Render mounts one at /data) arrives owned
# by root, so when the container starts as root it first makes the uploaded-files folder the app's own (#139).
set -e
dir="${FILE_STORAGE_DIR:-data/files}"
case "$dir" in /*) ;; *) dir="/app/$dir" ;; esac
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$dir"
  chown node:node "$dir"
  exec su-exec node "$@"
fi
exec "$@"
