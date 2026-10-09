#!/usr/bin/env bash
# Back up the production database. Run hourly from the host's cron (README,
# "Backups"):
#
#   scripts/pg-backup.sh
#
# Each run dumps the compose project's postgres (`docker exec`, so no port is
# published) to $BACKUP_DIR/hourly and keeps the newest $KEEP_HOURLY. The
# first run of a day also keeps that dump in $BACKUP_DIR/daily, for
# $KEEP_DAILY_DAYS days. When RESTIC_REPOSITORY is set (from $BACKUP_ENV),
# every run also sends a dump off site with restic, keeping 24 hourly, 30
# daily and 12 monthly snapshots. The dumps hold real email
# addresses and auth data: everything here is written mode 600, and the
# off-site copy is encrypted by restic.
#
# Env (all optional):
#   COMPOSE_PROJECT   default: acceptodds
#   BACKUP_DIR        default: ~/backups/acceptodds
#   KEEP_HOURLY       default: 6
#   KEEP_DAILY_DAYS   default: 14
#   BACKUP_ENV        default: ~/.config/acceptodds/backup.env (RESTIC_*, AWS_*)
set -euo pipefail
umask 077
PATH=$HOME/.local/bin:$PATH # restic, under cron's bare PATH

COMPOSE_PROJECT=${COMPOSE_PROJECT:-acceptodds}
BACKUP_DIR=${BACKUP_DIR:-$HOME/backups/acceptodds}
KEEP_HOURLY=${KEEP_HOURLY:-6}
KEEP_DAILY_DAYS=${KEEP_DAILY_DAYS:-14}
BACKUP_ENV=${BACKUP_ENV:-$HOME/.config/acceptodds/backup.env}

log() { echo "$(date -u +%FT%TZ) pg-backup: $*"; }

mkdir -p "$BACKUP_DIR/hourly" "$BACKUP_DIR/daily"

# One run at a time: a dump takes under a minute, but a slow disk must not
# stack them up.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "previous run still going, skipping"; exit 0; }

container=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
  --filter "label=com.docker.compose.service=postgres" --format '{{.Names}}' | head -n1)
[[ -n $container ]] || { log "no running postgres for project $COMPOSE_PROJECT" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/hourly/acceptodds-$stamp.dump"

# Custom format, zstd: about a third of the time gzip takes, restorable a
# table at a time with pg_restore. Written to .tmp and renamed only once it
# is whole, so a dump that died half way is never kept as a backup.
docker exec "$container" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z zstd:3' >"$out.tmp"
docker exec -i "$container" pg_restore --list >/dev/null <"$out.tmp" ||
  { rm -f "$out.tmp"; log "dump does not read back" >&2; exit 1; }
mv "$out.tmp" "$out"
log "wrote $out ($(du -h "$out" | cut -f1))"

ls -1t "$BACKUP_DIR"/hourly/acceptodds-*.dump | tail -n +"$((KEEP_HOURLY + 1))" | xargs -r rm -f

today=$(date -u +%Y%m%d)
first_today=false
if ! compgen -G "$BACKUP_DIR/daily/acceptodds-${today}T*.dump" >/dev/null; then
  first_today=true
  daily="$BACKUP_DIR/daily/$(basename "$out")"
  ln "$out" "$daily"
  log "kept $daily as today's daily"
  find "$BACKUP_DIR/daily" -name 'acceptodds-*.dump' -mtime "+$KEEP_DAILY_DAYS" -print -delete
fi

if [[ -f $BACKUP_ENV ]]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_ENV"; set +a
fi
if [[ -n ${RESTIC_REPOSITORY:-} ]]; then
  # A dump of its own, uncompressed: restic compresses and encrypts it, and
  # uploads only the chunks it has not seen. A compressed dump changes
  # throughout when one row does, and would go up whole every time.
  restic backup --quiet --stdin-filename acceptodds.dump --stdin-from-command -- \
    docker exec "$container" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z0'
  # Forgetting is cheap; pruning rewrites packs in the bucket, so once a day.
  prune=()
  $first_today && prune=(--prune)
  restic forget --quiet --group-by host,paths --keep-hourly 24 --keep-daily 30 --keep-monthly 12 "${prune[@]}"
  log "sent a dump off site${prune:+, pruned}"
fi
