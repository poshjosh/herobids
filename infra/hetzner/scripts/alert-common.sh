#!/usr/bin/env bash
# alert-common.sh — Alert threshold tracking and shared context for the
# Herobids Nomad autoscaler.
#
# Source this file in autoscale scripts to get:
#   - alert_failure() / clear_failure_count() — failure streak tracking
#   - build_alert_context() — builds a context blob for alerts
#   - send_alert() / send_recovery_alert() — trigger alert email
#   - Alert rate-limiting (max 1 alert per hour)
#
# Design:
#   - Failure count state file: /var/run/nomad-autoscale-failure-count
#   - Alert rate-limit file:    /var/run/nomad-autoscale-last-alert
#   - On success, clear the failure count and optionally send recovery email.
#   - On threshold crossed (default: 3 consecutive), send alert email.
#   - Rate-limit: don't send more than one alert per hour.
#
# SMTP approach:
#   - Use `sendmail` binary (available on most Linux) or `curl` to SMTP relay.
#   - Config via env vars: ALERT_SMTP_HOST, ALERT_SMTP_PORT, ALERT_FROM, ALERT_TO.
#   - Plain text email with structured subject: [herobids-{env}] Autoscale ALERT: {reason}
#   - Fall back to `logger` if SMTP not configured.
#
# Environment variables:
#   ALERT_SMTP_HOST                  SMTP relay hostname (e.g. smtp.example.com).
#   ALERT_SMTP_PORT                  SMTP port (default: 587).
#   ALERT_SMTP_USE_TLS               Use STARTTLS for SMTP (default: true).
#   ALERT_SMTP_USER                  SMTP auth username (optional).
#   ALERT_SMTP_PASS                  SMTP auth password (optional).
#   ALERT_FROM                       From address for alert emails.
#   ALERT_TO                         To address for alert emails (default admin).
#   ALERT_FAILURE_THRESHOLD          Consecutive failures before alert (default: 3).
#   ALERT_RATE_LIMIT_SECONDS         Min seconds between alerts (default: 3600).
#   ALERT_SEND_RECOVERY              Send recovery email on resume (default: false).
#   HEROBIDS_ENV                     Environment name (staging/production).
#   NOMAD_ADDR                       Nomad API base URL.
#   NOMAD_AUTOSCALE_FAILURE_COUNT_FILE  Path to failure count state file.
#   NOMAD_AUTOSCALE_LAST_ALERT_FILE  Path to last-alert timestamp file.
#   NOMAD_AUTOSCALE_LOG_FILE         Shared autoscale log file.
#   TERRAFORM_DIR                    Terraform working directory.
#   NOMAD_AUTOSCALE_NODE_COUNT_FILE  Node count state file.

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────

ALERT_SMTP_PORT="${ALERT_SMTP_PORT:-587}"
ALERT_SMTP_USE_TLS="${ALERT_SMTP_USE_TLS:-true}"
ALERT_FAILURE_THRESHOLD="${ALERT_FAILURE_THRESHOLD:-3}"
ALERT_RATE_LIMIT_SECONDS="${ALERT_RATE_LIMIT_SECONDS:-3600}"
ALERT_SEND_RECOVERY="${ALERT_SEND_RECOVERY:-false}"
NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${NOMAD_AUTOSCALE_FAILURE_COUNT_FILE:-/var/run/nomad-autoscale-failure-count}"
NOMAD_AUTOSCALE_LAST_ALERT_FILE="${NOMAD_AUTOSCALE_LAST_ALERT_FILE:-/var/run/nomad-autoscale-last-alert}"

# ─── Logging (if scale-common.sh not yet sourced) ──────────────────────────────

if ! declare -f log > /dev/null 2>&1; then
  _log_ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
  log() {
    local msg="$1"
    local ts; ts="$(_log_ts)"
    echo "[${ts}] ${msg}" >&2
  }
fi

# ─── SMTP detection ───────────────────────────────────────────────────────────

# _detect_sendmail — returns the path to sendmail if available, empty otherwise.
_detect_sendmail() {
  if command -v sendmail &>/dev/null; then
    command -v sendmail
    return 0
  fi
  return 1
}

# _detect_mail — returns the path to mail/mailx if available, empty otherwise.
_detect_mail() {
  if command -v mail &>/dev/null; then
    command -v mail
    return 0
  fi
  if command -v mailx &>/dev/null; then
    command -v mailx
    return 0
  fi
  return 1
}

# _smtp_configured — returns 0 if SMTP env vars are set, 1 otherwise.
# If ALERT_SMTP_USER is set, ALERT_SMTP_PASS must also be set (auth pairing).
_smtp_configured() {
  if [[ -z "${ALERT_SMTP_HOST:-}" || -z "${ALERT_FROM:-}" || -z "${ALERT_TO:-}" ]]; then
    return 1
  fi

  # Auth credential pairing: user requires pass, pass requires user.
  if [[ -n "${ALERT_SMTP_USER:-}" && -z "${ALERT_SMTP_PASS:-}" ]]; then
    log "WARNING: ALERT_SMTP_USER is set but ALERT_SMTP_PASS is missing — SMTP auth will not work. Skipping SMTP delivery."
    return 1
  fi

  if [[ -z "${ALERT_SMTP_USER:-}" && -n "${ALERT_SMTP_PASS:-}" ]]; then
    log "WARNING: ALERT_SMTP_PASS is set but ALERT_SMTP_USER is missing — SMTP auth will not work. Skipping SMTP delivery."
    return 1
  fi

  return 0
}

# ─── Alert rate-limit ─────────────────────────────────────────────────────────

# _alert_rate_limited — returns 0 if we are within the rate limit window
# (should NOT send), 1 if we can send.
_alert_rate_limited() {
  if [[ ! -f "${NOMAD_AUTOSCALE_LAST_ALERT_FILE}" ]]; then
    return 1  # No prior alert — not rate limited
  fi

  local last_ts
  last_ts="$(cat "${NOMAD_AUTOSCALE_LAST_ALERT_FILE}" 2>/dev/null || echo "0")"
  if [[ -z "${last_ts}" || "${last_ts}" == "0" ]]; then
    return 1
  fi

  local now; now="$(date +%s)"
  local elapsed=$(( now - last_ts ))
  if [[ ${elapsed} -ge ${ALERT_RATE_LIMIT_SECONDS} ]]; then
    return 1  # Rate limit expired
  fi

  local remaining=$(( ALERT_RATE_LIMIT_SECONDS - elapsed ))
  log "Alert rate-limited: ${remaining}s remaining before next alert."
  return 0
}

# _touch_alert_sent — record the timestamp of the last sent alert.
_touch_alert_sent() {
  local dir; dir="$(dirname "${NOMAD_AUTOSCALE_LAST_ALERT_FILE}")"
  mkdir -p "${dir}"
  date +%s > "${NOMAD_AUTOSCALE_LAST_ALERT_FILE}"
}

# ─── Failure count tracking ───────────────────────────────────────────────────

# _read_failure_count — reads the current consecutive failure count.
_read_failure_count() {
  if [[ ! -f "${NOMAD_AUTOSCALE_FAILURE_COUNT_FILE}" ]]; then
    echo "0"
    return 0
  fi
  local count
  count="$(cat "${NOMAD_AUTOSCALE_FAILURE_COUNT_FILE}" 2>/dev/null || echo "0")"
  echo "${count}"
}

# _write_failure_count <count> — persist a failure count.
_write_failure_count() {
  local count="$1"
  local dir; dir="$(dirname "${NOMAD_AUTOSCALE_FAILURE_COUNT_FILE}")"
  mkdir -p "${dir}"
  echo "${count}" > "${NOMAD_AUTOSCALE_FAILURE_COUNT_FILE}"
}

# alert_failure — increment the failure counter and return 0 if the alert
# threshold has been reached (caller should send alert).
#
# Usage:
#   if alert_failure; then
#     send_alert "scale_out_failed" "Terraform apply returned non-zero exit code."
#   fi
#
# Returns 0 if threshold crossed, 1 otherwise.
alert_failure() {
  local current; current="$(_read_failure_count)"
  local new_count=$(( current + 1 ))
  _write_failure_count "${new_count}"

  log "Alert: failure count incremented to ${new_count}/${ALERT_FAILURE_THRESHOLD}."

  if [[ ${new_count} -ge ${ALERT_FAILURE_THRESHOLD} ]]; then
    return 0  # Threshold reached — caller should send alert
  fi
  return 1
}

# clear_failure_count — reset the failure counter to 0.
# Optionally sends a recovery alert if ALERT_SEND_RECOVERY is true and we
# previously crossed the threshold.
#
# Usage:
#   clear_failure_count  # after a successful scale operation
clear_failure_count() {
  local previous; previous="$(_read_failure_count)"
  _write_failure_count 0

  if [[ "${previous}" -ge "${ALERT_FAILURE_THRESHOLD}" ]]; then
    log "Alert: failure count cleared (was ${previous}) — autoscaler recovered."
    if [[ "${ALERT_SEND_RECOVERY}" == "true" ]]; then
      send_recovery_alert
    fi
  else
    log "Alert: failure count cleared (was ${previous})."
  fi
}

# ─── Context builder ──────────────────────────────────────────────────────────

# build_alert_context <failure_type> <reason>
#
# Builds a multi-line context string for inclusion in alert emails.
# Includes: environment, failure type, reason, node count, recent Nomad
# eval errors, and the last terraform error (if available).
#
# Output: multi-line string (stdout).
build_alert_context() {
  local failure_type="$1"
  local reason="${2:-unknown}"

  local env="${HEROBIDS_ENV:-unknown}"
  local timestamp; timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local node_count="unknown"
  if [[ -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" ]]; then
    node_count="$(cat "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" 2>/dev/null || echo "unknown")"
  fi

  local failure_count
  failure_count="$(_read_failure_count)"

  cat <<EOF
Herobids Autoscale Alert
========================
Environment:    ${env}
Timestamp:      ${timestamp}
Failure Type:   ${failure_type}
Reason:         ${reason}
Consecutive Failures: ${failure_count}/${ALERT_FAILURE_THRESHOLD}
Current Node Count: ${node_count}

EOF

  # ── Nomad capacity snapshot ─────────────────────────────────────────────────
  if [[ -n "${NOMAD_ADDR:-}" ]] && command -v curl &>/dev/null; then
    echo "--- Nomad Capacity Snapshot ---"
    # Try the nodes summary endpoint for a quick capacity overview
    local nodes_json
    nodes_json="$(curl -s --connect-timeout 10 --max-time 30 "${NOMAD_ADDR}/v1/nodes" 2>/dev/null || true)"
    if [[ -n "${nodes_json}" ]]; then
      local total ready down
      total="$(echo "${nodes_json}" | jq -r 'length' 2>/dev/null || echo "?")"
      ready="$(echo "${nodes_json}" | jq -r '[.[] | select(.Status == "ready")] | length' 2>/dev/null || echo "?")"
      down="$(echo "${nodes_json}" | jq -r '[.[] | select(.Status == "down")] | length' 2>/dev/null || echo "?")"
      echo "  Total nodes:    ${total}"
      echo "  Ready:          ${ready}"
      echo "  Down:           ${down}"
    else
      echo "  (Nomad API unreachable)"
    fi

    # ── Last 5 resource-exhaustion blocked evaluations ────────────────────────
    echo ""
    echo "--- Recent Blocked Evaluations (last 5) ---"
    local evals_json
    evals_json="$(curl -s --connect-timeout 10 --max-time 30 "${NOMAD_ADDR}/v1/evaluations" 2>/dev/null || true)"
    if [[ -n "${evals_json}" ]]; then
      local blocked
      blocked="$(echo "${evals_json}" | jq -r '
        [.[] | select(.Status == "blocked")] |
        sort_by(-.CreateTime // 0) |
        .[:5] |
        .[] |
        "  EvalID=\(.ID // "?") JobID=\(.JobID // "?") Reason=\(.BlockedEval // "none")"
      ' 2>/dev/null || echo "  (unable to parse evaluations)")"
      if [[ -n "${blocked}" ]]; then
        echo "${blocked}"
      else
        echo "  (no blocked evaluations)"
      fi
    else
      echo "  (Nomad API unreachable)"
    fi
    echo ""
  fi

  # ── Terraform backend info ────────────────────────────────────────────────────
  echo "--- Terraform Backend ---"
  echo "  Backend:  S3 (remote)"
  echo "  Bucket:   ${TF_BACKEND_BUCKET:-<not set>}"
  echo "  Region:   ${TF_BACKEND_REGION:-<not set>}"
  echo "  Key:      herobids/${env}/terraform.tfstate"
  if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
    echo "  Lock table: ${TF_BACKEND_DYNAMODB_TABLE}"
  fi
  echo "  Dir:      ${TERRAFORM_DIR:-<not set>}"
  echo ""

  # ── Recent autoscale log tail ───────────────────────────────────────────────
  local log_file="${NOMAD_AUTOSCALE_LOG_FILE:-/var/log/nomad-autoscale.log}"
  if [[ -f "${log_file}" ]]; then
    echo "--- Recent Autoscale Log (last 20 lines) ---"
    tail -n 20 "${log_file}" 2>/dev/null || echo "  (unable to read log)"
    echo ""
  fi

  echo "---"
  echo "Manual recovery: see infra/hetzner/README.md — 'Alerting & Manual Recovery' section."
  echo "Generated by herobids-nomad-autoscaler."
}

# ─── Email sending ────────────────────────────────────────────────────────────

# _send_via_sendmail <subject> <body>
# Sends a plain-text email via the sendmail binary.
_send_via_sendmail() {
  local subject="$1"
  local body="$2"
  local from="${ALERT_FROM:-herobids@localhost}"
  local to="${ALERT_TO}"

  local sendmail_bin
  sendmail_bin="$(_detect_sendmail)" || {
    log "ERROR: sendmail not found in PATH."
    return 1
  }

  local ret=0
  "${sendmail_bin}" -t <<EOF
From: ${from}
To: ${to}
Subject: ${subject}
Content-Type: text/plain; charset=utf-8

${body}
EOF
  ret=$?

  if [[ ${ret} -eq 0 ]]; then
    log "Alert email sent via sendmail to ${to}."
  else
    log "ERROR: sendmail failed with exit code ${ret}."
  fi
  return ${ret}
}

# _send_via_mail <subject> <body>
# Sends a plain-text email via the mail/mailx command.
_send_via_mail() {
  local subject="$1"
  local body="$2"
  local from="${ALERT_FROM:-herobids@localhost}"
  local to="${ALERT_TO}"

  local mail_bin
  mail_bin="$(_detect_mail)" || {
    log "ERROR: mail/mailx not found in PATH."
    return 1
  }

  local ret=0
  echo "${body}" | "${mail_bin}" -s "${subject}" -a "From: ${from}" "${to}"
  ret=$?

  if [[ ${ret} -eq 0 ]]; then
    log "Alert email sent via mail to ${to}."
  else
    log "ERROR: mail command failed with exit code ${ret}."
  fi
  return ${ret}
}

# _send_via_curl_smtp <subject> <body>
# Sends a plain-text email via curl to an SMTP relay (RFC 5321).
# Uses STARTTLS if ALERT_SMTP_USE_TLS is true.
_send_via_curl_smtp() {
  local subject="$1"
  local body="$2"
  local from="${ALERT_FROM}"
  local to="${ALERT_TO}"
  local host="${ALERT_SMTP_HOST}"
  local port="${ALERT_SMTP_PORT}"
  local user="${ALERT_SMTP_USER:-}"
  local pass="${ALERT_SMTP_PASS:-}"

  # Build the raw email message
  local raw_email
  raw_email="From: ${from}
To: ${to}
Subject: ${subject}
Content-Type: text/plain; charset=utf-8
Date: $(date -R)

${body}
"

  # Determine protocol based on TLS setting
  local proto="smtp"
  if [[ "${ALERT_SMTP_USE_TLS}" == "true" ]]; then
    proto="smtps"  # implicit TLS on port 465
    # If port is 587, use smtp with STARTTLS
    if [[ "${port}" == "587" ]]; then
      proto="smtp"
    fi
  fi

  local curl_args=(
    --silent
    --show-error
    --connect-timeout 15
    --max-time 30
    --mail-from "${from}"
    --mail-rcpt "${to}"
    --upload-file -
  )

  # Add TLS options
  if [[ "${proto}" == "smtps" ]]; then
    curl_args+=(--ssl-reqd)
  fi

  # Add auth if credentials provided
  if [[ -n "${user}" && -n "${pass}" ]]; then
    curl_args+=(--user "${user}:${pass}")
  fi

  # Use STARTTLS for port 587
  if [[ "${port}" == "587" && "${ALERT_SMTP_USE_TLS}" == "true" ]]; then
    curl_args+=(--ssl-reqd)
  fi

  curl_args+=("${proto}://${host}:${port}")

  local ret=0
  echo "${raw_email}" | curl "${curl_args[@]}" 2>&1
  ret=$?

  if [[ ${ret} -eq 0 ]]; then
    log "Alert email sent via curl SMTP to ${to} (${host}:${port})."
  else
    log "ERROR: curl SMTP failed with exit code ${ret}."
  fi
  return ${ret}
}

# _send_via_logger <subject> <body>
# Fallback: log the alert to syslog when SMTP is not configured.
_send_via_logger() {
  local subject="$1"
  local body="$2"

  if command -v logger &>/dev/null; then
    echo "${body}" | logger -t "nomad-autoscale-alert" -p user.err
    log "Alert logged to syslog (SMTP not configured)."
  else
    log "ALERT (SMTP not configured, logger unavailable): ${subject}"
    log "${body}"
  fi
}

# send_alert <failure_type> <reason>
#
# Send an alert email for a scaling failure. Respects rate limits and
# falls back to logger if SMTP is not configured.
#
# Usage:
#   send_alert "scale_out_failed" "Terraform apply exited with code 1."
send_alert() {
  local failure_type="$1"
  local reason="${2:-unknown}"
  local env="${HEROBIDS_ENV:-unknown}"

  # Check rate limit
  if _alert_rate_limited; then
    return 0
  fi

  local subject="[herobids-${env}] Autoscale ALERT: ${failure_type}"
  local context
  context="$(build_alert_context "${failure_type}" "${reason}")"

  local sent=false

  # Try sendmail first (most common on Linux)
  if _detect_sendmail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_sendmail "${subject}" "${context}"; then
      sent=true
    fi
  fi

  # Try mail/mailx
  if [[ "${sent}" != "true" ]] && _detect_mail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_mail "${subject}" "${context}"; then
      sent=true
    fi
  fi

  # Try curl SMTP
  if [[ "${sent}" != "true" ]] && _smtp_configured; then
    if _send_via_curl_smtp "${subject}" "${context}"; then
      sent=true
    fi
  fi

  # Fallback to logger
  if [[ "${sent}" != "true" ]]; then
    _send_via_logger "${subject}" "${context}"
  fi

  # Record alert timestamp (rate limit)
  _touch_alert_sent
}

# send_recovery_alert
#
# Send a recovery notification email. Only called when ALERT_SEND_RECOVERY=true
# and a previous failure streak has been cleared.
send_recovery_alert() {
  local env="${HEROBIDS_ENV:-unknown}"
  local node_count="unknown"
  if [[ -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" ]]; then
    node_count="$(cat "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" 2>/dev/null || echo "unknown")"
  fi

  local subject="[herobids-${env}] Autoscale RECOVERY: normal operation resumed"
  local body
  body="Herobids Autoscale Recovery
==========================
Environment:    ${env}
Timestamp:      $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Status:         Normal operation resumed.
Node Count:     ${node_count}

The autoscaler has recovered from a previous failure streak.
Scaling operations are proceeding normally.

---
Generated by herobids-nomad-autoscaler.
"

  local sent=false

  if _detect_sendmail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_sendmail "${subject}" "${body}"; then
      sent=true
    fi
  fi

  if [[ "${sent}" != "true" ]] && _detect_mail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_mail "${subject}" "${body}"; then
      sent=true
    fi
  fi

  if [[ "${sent}" != "true" ]] && _smtp_configured; then
    if _send_via_curl_smtp "${subject}" "${body}"; then
      sent=true
    fi
  fi

  if [[ "${sent}" != "true" ]]; then
    _send_via_logger "${subject}" "${body}"
  fi
}
