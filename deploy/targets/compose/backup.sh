#!/bin/sh
# Runs in the backup container: once at start, then every 24 hours, the database (mongodump) and the
# uploaded files go into /backups (./backups on the server), and copies older than BACKUP_DAYS are removed.
# Restore the database: mongorestore --uri "$MONGODB_URI" --gzip --archive=backups/db-<stamp>.gz --drop
set -eu
days="${BACKUP_DAYS:-14}"
while true; do
  stamp="$(date -u +%Y-%m-%dT%H%MZ)"
  if mongodump --uri="$MONGODB_URI" --gzip --archive="/backups/db-$stamp.gz" --quiet; then
    echo "backup: db-$stamp.gz"
  else
    echo "backup: the database backup failed" >&2
  fi
  tar -czf "/backups/files-$stamp.tar.gz" -C /data files && echo "backup: files-$stamp.tar.gz"
  find /backups -name 'db-*.gz' -mtime +"$days" -delete
  find /backups -name 'files-*.tar.gz' -mtime +"$days" -delete
  sleep 86400
done
