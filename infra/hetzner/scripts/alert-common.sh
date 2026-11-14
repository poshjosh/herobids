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
# Delivery approach:
#   - Email: `sendmail` binary (available on most Linux) or `curl` to SMTP relay.
#   - Telegram: Bot API `sendMessage` via `curl` (optional, additive channel).
#   - Config via env vars (see below).
#   - Plain text email with structured subject: [herobids-{env}] Autoscale ALERT: {reason}
#   - Email and Telegram are independent, additive channels: when both are
#     configured, an alert is delivered to both. Email falls back to `logger`
#     if no SMTP transport is available; Telegram is skipped silently if not
#     configured.
#
# Environment variables:
#   ALERT_SMTP_HOST                  SMTP relay hostname (e.g. smtp.example.com).
#   ALERT_SMTP_PORT                  SMTP port (default: 587).
#   ALERT_SMTP_USE_TLS               Use STARTTLS for SMTP (default: true).
#   ALERT_SMTP_USER                  SMTP auth username (optional).
#   ALERT_SMTP_PASS                  SMTP auth password (optional).
#   ALERT_FROM                       From address for alert emails.
#   ALERT_TO                         Recipient address(es) for alert emails.
#                                    Multiple addresses may be separated by
#                                    commas, semicolons, or whitespace.
#   ALERT_TELEGRAM_BOT_TOKEN         Telegram bot token for alert delivery
#                                    (optional; enables the Telegram channel).
#   ALERT_TELEGRAM_CHAT_IDS          Telegram chat id(s) to notify. Multiple
#                                    ids may be separated by commas, semicolons,
#                                    or whitespace.
#   ALERT_FAILURE_THRESHOLD          Consecutive failures before alert (default: 3).
#   ALERT_RATE_LIMIT_SECONDS         Min seconds between alerts (default: 3600).
#   ALERT_SEND_RECOVERY              Send recovery alert on resume (default: false).
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

# _split_recipients <raw> — split a recipient list on commas, semicolons, or
# whitespace and print one trimmed, non-empty entry per line.
# Used for both email addresses (ALERT_TO) and Telegram chat ids.
_split_recipients() {
  local raw="${1:-}"
  echo "${raw}" | tr ',;' '  ' | tr -s '[:space:]' '\n' | sed '/^$/d'
}

# _telegram_configured — returns 0 if the Telegram channel is configured
# (bot token + at least one chat id), 1 otherwise.
_telegram_configured() {
  local has_chat_ids=false
  if [[ -n "$(_split_recipients "${ALERT_TELEGRAM_CHAT_IDS:-}")" ]]; then
    has_chat_ids=true
  fi

  if [[ -z "${ALERT_TELEGRAM_BOT_TOKEN:-}" ]]; then
    if [[ "${has_chat_ids}" == "true" ]]; then
      log "WARNING: ALERT_TELEGRAM_CHAT_IDS is set but ALERT_TELEGRAM_BOT_TOKEN is empty — skipping Telegram delivery."
    fi
    return 1
  fi
  if [[ "${has_chat_ids}" != "true" ]]; then
    log "WARNING: ALERT_TELEGRAM_BOT_TOKEN is set but ALERT_TELEGRAM_CHAT_IDS is empty — skipping Telegram delivery."
    return 1
  fi
  if ! command -v curl &>/dev/null; then
    log "WARNING: Telegram configured but curl is unavailable — skipping Telegram delivery."
    return 1
  fi
  return 0
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
  # Dry-run must not mutate state, and must not signal an alert: the callers
  # send one when this returns 0.
  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    log "[DRY-RUN] Failure not recorded and no alert sent."
    return 1
  fi

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
    # Build auth header for direct curl calls
    local -a _alert_auth=()
    if [[ -n "${NOMAD_TOKEN:-}" ]]; then
      _alert_auth+=(-H "X-Nomad-Token: ${NOMAD_TOKEN}")
    fi
    # Try the nodes summary endpoint for a quick capacity overview
    local nodes_json
    nodes_json="$(curl -s --connect-timeout 10 --max-time 30 ${_alert_auth[@]+"${_alert_auth[@]}"} "${NOMAD_ADDR}/v1/nodes" 2>/dev/null || true)"
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
    evals_json="$(curl -s --connect-timeout 10 --max-time 30 ${_alert_auth[@]+"${_alert_auth[@]}"} "${NOMAD_ADDR}/v1/evaluations" 2>/dev/null || true)"
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

  # Comma-join all recipients for the To: header (sendmail -t reads recipients
  # from the header).
  local to
  to="$(_split_recipients "${ALERT_TO}" | paste -sd ',' -)"
  if [[ -z "${to}" ]]; then
    log "ERROR: no recipients in ALERT_TO."
    return 1
  fi

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

  # mail/mailx accepts multiple recipient address arguments.
  local -a recipients=()
  local addr
  while IFS= read -r addr; do
    [[ -n "${addr}" ]] && recipients+=("${addr}")
  done < <(_split_recipients "${ALERT_TO}")

  if [[ ${#recipients[@]} -eq 0 ]]; then
    log "ERROR: no recipients in ALERT_TO."
    return 1
  fi

  local mail_bin
  mail_bin="$(_detect_mail)" || {
    log "ERROR: mail/mailx not found in PATH."
    return 1
  }

  local ret=0
  echo "${body}" | "${mail_bin}" -s "${subject}" -a "From: ${from}" "${recipients[@]}"
  ret=$?

  if [[ ${ret} -eq 0 ]]; then
    log "Alert email sent via mail to ${recipients[*]}."
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
  local host="${ALERT_SMTP_HOST}"
  local port="${ALERT_SMTP_PORT}"
  local user="${ALERT_SMTP_USER:-}"
  local pass="${ALERT_SMTP_PASS:-}"

  # Parse recipients: one --mail-rcpt per address, comma-joined for the header.
  local -a recipients=()
  local addr
  while IFS= read -r addr; do
    [[ -n "${addr}" ]] && recipients+=("${addr}")
  done < <(_split_recipients "${ALERT_TO}")

  if [[ ${#recipients[@]} -eq 0 ]]; then
    log "ERROR: no recipients in ALERT_TO."
    return 1
  fi

  local to
  to="$(IFS=','; echo "${recipients[*]}")"

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
    --upload-file -
  )

  # One --mail-rcpt per recipient (envelope recipients).
  for addr in "${recipients[@]}"; do
    curl_args+=(--mail-rcpt "${addr}")
  done

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
# Fallback: log the alert to syslog when no delivery channel succeeded.
_send_via_logger() {
  local subject="$1"
  local body="$2"

  if command -v logger &>/dev/null; then
    echo "${body}" | logger -t "nomad-autoscale-alert" -p user.err
    log "Alert logged to syslog (no email or Telegram channel delivered it)."
  else
    log "ALERT (no email or Telegram channel delivered it, logger unavailable): ${subject}"
    log "${body}"
  fi
}

# ─── Telegram sending ─────────────────────────────────────────────────────────

# _telegram_send_to_chat <chat_id> <text>
# Sends a plain-text message to a single Telegram chat via the Bot API.
# Returns 0 on success, 1 on failure.
_telegram_send_to_chat() {
  local chat_id="$1"
  local text="$2"
  local token="${ALERT_TELEGRAM_BOT_TOKEN}"

  # Telegram messages are capped at 4096 characters.
  if [[ ${#text} -gt 4096 ]]; then
    text="${text:0:4093}..."
  fi

  # The URL embeds the bot token, so pass it via a curl config on stdin rather
  # than argv (argv is visible to other users through `ps`).
  local response
  response="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "${token}" |
    curl -s --show-error \
      --connect-timeout 15 --max-time 30 \
      -X POST \
      --config - \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${text}" \
      --data-urlencode "disable_web_page_preview=true" 2>&1)" || {
    log "ERROR: Telegram delivery to chat ${chat_id} failed (curl error): ${response//${token}/<token>}"
    return 1
  }

  # The Bot API returns {"ok":true,...} on success.
  if command -v jq &>/dev/null; then
    local ok
    ok="$(echo "${response}" | jq -r '.ok // false' 2>/dev/null || echo "false")"
    if [[ "${ok}" == "true" ]]; then
      log "Alert sent via Telegram to chat ${chat_id}."
      return 0
    fi
    log "ERROR: Telegram delivery to chat ${chat_id} rejected: ${response}"
    return 1
  fi

  # Fallback without jq: crude substring check.
  if [[ "${response}" == *'"ok":true'* ]]; then
    log "Alert sent via Telegram to chat ${chat_id}."
    return 0
  fi
  log "ERROR: Telegram delivery to chat ${chat_id} rejected: ${response}"
  return 1
}

# _send_via_telegram <subject> <body>
# Sends the alert to every configured Telegram chat id. Returns 0 if at least
# one chat received the message, 1 otherwise. No-op (returns 1) if Telegram is
# not configured.
_send_via_telegram() {
  local subject="$1"
  local body="$2"

  if ! _telegram_configured; then
    return 1
  fi

  # Lead with the subject so the chat shows the alert type at a glance.
  local text="${subject}

${body}"

  local any_sent=1
  local chat_id
  while IFS= read -r chat_id; do
    [[ -z "${chat_id}" ]] && continue
    if _telegram_send_to_chat "${chat_id}" "${text}"; then
      any_sent=0
    fi
  done < <(_split_recipients "${ALERT_TELEGRAM_CHAT_IDS}")

  return ${any_sent}
}

# _deliver_alert <subject> <body>
#
# Deliver an alert over every configured channel. Email and Telegram are
# independent, additive channels:
#   - Email tries sendmail → mail/mailx → curl SMTP, stopping at the first that
#     succeeds.
#   - Telegram delivers to every configured chat id whenever a bot token and
#     chat id(s) are set, regardless of the email outcome.
#   - If neither channel delivered (not configured, or every attempt failed),
#     the alert falls back to `logger` so a failure is never silent.
_deliver_alert() {
  local subject="$1"
  local body="$2"

  local email_sent=false

  # ── Email channel (first transport wins) ──
  if _detect_sendmail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_sendmail "${subject}" "${body}"; then
      email_sent=true
    fi
  fi

  if [[ "${email_sent}" != "true" ]] && _detect_mail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
    if _send_via_mail "${subject}" "${body}"; then
      email_sent=true
    fi
  fi

  if [[ "${email_sent}" != "true" ]] && _smtp_configured; then
    if _send_via_curl_smtp "${subject}" "${body}"; then
      email_sent=true
    fi
  fi

  # ── Telegram channel (additive, independent of email) ──
  local telegram_sent=false
  if _send_via_telegram "${subject}" "${body}"; then
    telegram_sent=true
  fi

  # ── Fallback: only log to syslog if NOTHING was delivered ──
  if [[ "${email_sent}" != "true" && "${telegram_sent}" != "true" ]]; then
    _send_via_logger "${subject}" "${body}"
  fi
}

# send_alert <failure_type> <reason>
#
# Send an alert for a scaling failure over all configured channels (email and
# Telegram). Respects rate limits and falls back to logger if no channel is
# configured.
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

  _deliver_alert "${subject}" "${context}"

  # Record alert timestamp (rate limit)
  _touch_alert_sent
}

# send_recovery_alert
#
# Send a recovery notification over all configured channels (email and
# Telegram). Only called when ALERT_SEND_RECOVERY=true and a previous failure
# streak has been cleared.
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

  _deliver_alert "${subject}" "${body}"
}
