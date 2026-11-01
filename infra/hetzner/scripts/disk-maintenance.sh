#!/usr/bin/env bash
# Host-side disk maintenance for herobids control planes.
# Installed as /usr/local/sbin/herobids-disk-maintenance.
#   --install   write cron, journald and logrotate config (idempotent)
#   (default)   prune build cache and dangling images, cap journal,
#               delete dumps and syslog archives older than RETENTION_DAYS
set -uo pipefail

BACKUP_DIR=/opt/herobids-backup
LOG_DIR=/var/log
RETENTION_DAYS=7
BUILD_CACHE_UNTIL=72h
JOURNAL_MAX_SIZE=200M
SCRIPT_PATH=/usr/local/sbin/herobids-disk-maintenance

log() {
  logger -t herobids-disk-maintenance -- "$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

install_config() {
  install -d -m 0755 /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/herobids.conf <<EOF
[Journal]
SystemMaxUse=${JOURNAL_MAX_SIZE}
EOF

  cat > /etc/logrotate.d/herobids-backup <<'EOF'
/var/log/herobids-backup.log /var/log/herobids-disk-maintenance.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
}
EOF

  cat > /etc/cron.d/herobids-disk-maintenance <<EOF
# Daily disk maintenance, after the 03:00 Postgres dump
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 4 * * * root ${SCRIPT_PATH} >> /var/log/herobids-disk-maintenance.log 2>&1
EOF
  chmod 0644 /etc/cron.d/herobids-disk-maintenance /etc/logrotate.d/herobids-backup

  systemctl restart systemd-journald || log "WARN could not restart systemd-journald"
  log "installed disk maintenance config"
}

run_maintenance() {
  if docker info >/dev/null 2>&1; then
    docker builder prune -f --filter "until=${BUILD_CACHE_UNTIL}" >/dev/null \
      || log "WARN builder prune failed"
    docker image prune -f >/dev/null || log "WARN image prune failed"
    log "pruned build cache older than ${BUILD_CACHE_UNTIL} and dangling images"
  else
    log "WARN docker not available; skipped docker prune"
  fi

  journalctl --vacuum-size="${JOURNAL_MAX_SIZE}" >/dev/null 2>&1 \
    || log "WARN journal vacuum failed"

  if [ -d "${BACKUP_DIR}" ]; then
    find "${BACKUP_DIR}" -maxdepth 1 -name 'herobids-*.sql' -mtime +"${RETENTION_DAYS}" -print -delete
  fi
  find "${LOG_DIR}" -maxdepth 1 -name 'syslog.*' -mtime +"${RETENTION_DAYS}" -print -delete

  log "done; root filesystem: $(df -h / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}')"
}

case "${1:-}" in
  --install) install_config ;;
  "") run_maintenance ;;
  *) echo "usage: $0 [--install]" >&2; exit 2 ;;
esac
