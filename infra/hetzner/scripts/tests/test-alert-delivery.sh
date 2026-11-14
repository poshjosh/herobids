#!/usr/bin/env bash
# test-alert-delivery.sh — recipient parsing and channel delivery tests for
# alert-common.sh (email: sendmail / mail / curl SMTP; Telegram; logger fallback).
#
# Every transport (sendmail, mail, curl, logger) is a stub on an isolated PATH,
# so nothing touches the network or the host mail system.
#
# Run: bash infra/hetzner/scripts/tests/test-alert-delivery.sh
set -uo pipefail
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "${TESTS_DIR}")"
source "${TESTS_DIR}/test-harness.sh"

TMP="$(create_test_tmpdir)"
trap 'rm -rf "${TMP}"' EXIT

MOCK_BIN="${TMP}/bin"
CALLS="${TMP}/calls"
mkdir -p "${MOCK_BIN}" "${CALLS}"

# ─── Isolated PATH: only the tools alert-common.sh needs, plus stubs ──────────
for tool in bash tr sed paste date cat dirname mkdir tee head rm touch wc sleep ls grep; do
  src="$(command -v "${tool}" 2>/dev/null || true)"
  [[ -n "${src}" ]] && ln -sf "${src}" "${MOCK_BIN}/${tool}"
done

# curl stub. Records the argv and the stdin it was given, then answers based on
# CURL_MODE: ok | reject | fail | reject_bad_chat (reject only when chat_id=BAD).
cat > "${MOCK_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
n=$(( $(ls "${CALLS_DIR}" | grep -c '^curl\.args\.') + 1 ))
printf '%s\n' "$@" > "${CALLS_DIR}/curl.args.${n}"
for a in "$@"; do
  [[ "${a}" == text=* ]] && printf '%s' "${a#text=}" > "${CALLS_DIR}/curl.text.${n}"
done
cat > "${CALLS_DIR}/curl.stdin.${n}"
if grep -q 'api.telegram.org' "${CALLS_DIR}/curl.stdin.${n}"; then
  case "${CURL_MODE:-ok}" in
    ok) echo '{"ok":true,"result":{}}' ;;
    reject) echo '{"ok":false,"description":"chat not found"}' ;;
    fail) echo "curl: (6) Could not resolve host: api.telegram.org" >&2; exit 6 ;;
    reject_bad_chat)
      if grep -qx 'chat_id=BAD' "${CALLS_DIR}/curl.args.${n}"; then
        echo '{"ok":false,"description":"chat not found"}'
      else
        echo '{"ok":true}'
      fi ;;
  esac
fi
exit 0
STUB

cat > "${MOCK_BIN}/sendmail" <<'STUB'
#!/usr/bin/env bash
cat > "${CALLS_DIR}/sendmail.in"
exit "${SENDMAIL_EXIT:-0}"
STUB

cat > "${MOCK_BIN}/mail" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
printf '%s\n' "$@" > "${CALLS_DIR}/mail.args"
exit 0
STUB

cat > "${MOCK_BIN}/logger" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
touch "${CALLS_DIR}/logger.called"
exit 0
STUB
chmod +x "${MOCK_BIN}"/curl "${MOCK_BIN}"/sendmail "${MOCK_BIN}"/mail "${MOCK_BIN}"/logger

# reset_calls — clear recorded transport calls between scenarios.
reset_calls() { rm -rf "${CALLS}"; mkdir -p "${CALLS}"; }

# run_alert <function> [args...] — run an alert-common.sh function in a subshell
# with the isolated PATH. Per-scenario settings come from the caller's
# environment (ALERT_*, CURL_MODE, SENDMAIL_EXIT) and are exported to the stubs.
# Sets RUN_OUTPUT (stdout+stderr) and RUN_EXIT.
run_alert() {
  RUN_EXIT=0
  RUN_OUTPUT="$(
    exec 2>&1
    export PATH="${MOCK_BIN}"
    export CALLS_DIR="${CALLS}"
    export NOMAD_AUTOSCALE_LOG_FILE="${TMP}/autoscale.log"
    export NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TMP}/failure-count"
    export NOMAD_AUTOSCALE_LAST_ALERT_FILE="${TMP}/last-alert"
    export TERRAFORM_DIR="${TMP}/terraform"
    export HEROBIDS_ENV="staging"
    touch "${NOMAD_AUTOSCALE_LOG_FILE}"
    # shellcheck disable=SC1091
    source "${SCRIPTS_DIR}/scale-common.sh"
    # shellcheck disable=SC1091
    source "${SCRIPTS_DIR}/alert-common.sh"
    "$@"
  )" || RUN_EXIT=$?
}

# clear_alert_env — unset every variable that selects a channel.
clear_alert_env() {
  unset ALERT_TO ALERT_FROM ALERT_SMTP_HOST ALERT_SMTP_PORT ALERT_SMTP_USER ALERT_SMTP_PASS \
    ALERT_TELEGRAM_BOT_TOKEN ALERT_TELEGRAM_CHAT_IDS CURL_MODE SENDMAIL_EXIT
}

curl_call_count() {
  local count=0 f
  for f in "${CALLS}"/curl.args.*; do
    [[ -e "${f}" ]] && count=$(( count + 1 ))
  done
  echo "${count}"
}

test_begin "alert-common.sh recipient parsing and channel delivery"

# ─── _split_recipients ────────────────────────────────────────────────────────
clear_alert_env
run_alert _split_recipients "a@x.com, b@y.com;c@z.com  d@w.com"
assert_eq "${RUN_OUTPUT//$'\n'/|}" "a@x.com|b@y.com|c@z.com|d@w.com" \
  "_split_recipients splits on commas, semicolons and whitespace"

run_alert _split_recipients ""
assert_eq "${RUN_OUTPUT}" "" "_split_recipients yields nothing for empty input"

run_alert _split_recipients " , ; "
assert_eq "${RUN_OUTPUT}" "" "_split_recipients yields nothing for separators only"

run_alert _split_recipients "-1001234567890, 987654321"
assert_eq "${RUN_OUTPUT//$'\n'/|}" "-1001234567890|987654321" \
  "_split_recipients keeps negative Telegram chat ids intact"

# ─── _telegram_configured ─────────────────────────────────────────────────────
clear_alert_env
run_alert _telegram_configured
assert_eq "${RUN_EXIT}" "1" "Telegram is not configured with neither token nor chat ids"
assert_eq "${RUN_OUTPUT}" "" "no warning when Telegram is simply unused"

clear_alert_env
export ALERT_TELEGRAM_BOT_TOKEN="123:abc"
run_alert _telegram_configured
assert_eq "${RUN_EXIT}" "1" "Telegram is not configured with a token but no chat ids"
assert_contains "${RUN_OUTPUT}" "ALERT_TELEGRAM_CHAT_IDS is empty" "warns when chat ids are missing"

clear_alert_env
export ALERT_TELEGRAM_CHAT_IDS="42"
run_alert _telegram_configured
assert_eq "${RUN_EXIT}" "1" "Telegram is not configured with chat ids but no token"
assert_contains "${RUN_OUTPUT}" "ALERT_TELEGRAM_BOT_TOKEN is empty" "warns when the token is missing"

clear_alert_env
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42"
run_alert _telegram_configured
assert_eq "${RUN_EXIT}" "0" "Telegram is configured with token and chat id"

# ─── Telegram-only delivery ───────────────────────────────────────────────────
clear_alert_env; reset_calls
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42, -100777" CURL_MODE=ok
run_alert _deliver_alert "SUBJ" "BODY"
assert_eq "$(curl_call_count)" "2" "one Telegram request per chat id"
assert_contains "${RUN_OUTPUT}" "Alert sent via Telegram to chat 42" "logs delivery to the first chat"
assert_contains "${RUN_OUTPUT}" "Alert sent via Telegram to chat -100777" "logs delivery to the second chat"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "no" \
  "logger fallback is not used when Telegram delivered"

first_args="$(cat "${CALLS}/curl.args.1")"
first_stdin="$(cat "${CALLS}/curl.stdin.1")"
assert_not_contains "${first_args}" "123:abc" "bot token is not in curl argv"
assert_contains "${first_stdin}" "bot123:abc/sendMessage" "bot token is passed via the curl config on stdin"
assert_contains "${first_args}" "chat_id=42" "chat id is sent as a form field"
assert_contains "${first_args}" "SUBJ" "message text leads with the subject"

# ─── Telegram: one chat failing does not block the others ─────────────────────
clear_alert_env; reset_calls
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="BAD 42" CURL_MODE=reject_bad_chat
run_alert _deliver_alert "SUBJ" "BODY"
assert_eq "$(curl_call_count)" "2" "every chat is attempted even after a rejection"
assert_contains "${RUN_OUTPUT}" "chat BAD rejected" "rejected chat is logged"
assert_contains "${RUN_OUTPUT}" "Alert sent via Telegram to chat 42" "healthy chat still receives the alert"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "no" \
  "no logger fallback when at least one chat received the alert"

# ─── Telegram: total failure falls back to logger ─────────────────────────────
clear_alert_env; reset_calls
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42" CURL_MODE=reject
run_alert _deliver_alert "SUBJ" "BODY"
assert_contains "${RUN_OUTPUT}" "rejected" "rejected response is logged"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "yes" \
  "logger fallback runs when Telegram rejects and nothing else delivered"

clear_alert_env; reset_calls
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42" CURL_MODE=fail
run_alert _deliver_alert "SUBJ" "BODY"
assert_contains "${RUN_OUTPUT}" "Could not resolve host" "curl failure reason is logged"
assert_not_contains "${RUN_OUTPUT}" "123:abc" "bot token never appears in logs"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "yes" \
  "logger fallback runs when the Telegram request fails"

# ─── Telegram: message truncated to the API limit ─────────────────────────────
clear_alert_env; reset_calls
export ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42" CURL_MODE=ok
long_body="$(head -c 5000 < /dev/zero | tr '\0' 'x')"
run_alert _deliver_alert "SUBJ" "${long_body}"
text_arg="$(cat "${CALLS}/curl.text.1")"
assert_eq "${#text_arg}" "4096" "Telegram text is truncated to 4096 characters"

# ─── Email: multiple recipients ───────────────────────────────────────────────
clear_alert_env; reset_calls
export ALERT_TO="a@x.com, b@y.com;c@z.com" ALERT_FROM="alerts@x.com"
run_alert _deliver_alert "SUBJ" "BODY"
assert_contains "$(cat "${CALLS}/sendmail.in")" "To: a@x.com,b@y.com,c@z.com" \
  "sendmail To: header lists every recipient"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "no" \
  "no logger fallback when sendmail delivered"

clear_alert_env; reset_calls
export ALERT_TO="a@x.com, b@y.com" ALERT_FROM="alerts@x.com" SENDMAIL_EXIT=1
run_alert _deliver_alert "SUBJ" "BODY"
mail_args="$(cat "${CALLS}/mail.args")"
assert_contains "${mail_args}" $'\na@x.com' "mail is called with the first recipient as its own argument"
assert_contains "${mail_args}" $'\nb@y.com' "mail is called with the second recipient as its own argument"

# ─── Email via curl SMTP: one --mail-rcpt per recipient ───────────────────────
clear_alert_env; reset_calls
rm -f "${MOCK_BIN}/sendmail" "${MOCK_BIN}/mail"
export ALERT_TO="a@x.com, b@y.com" ALERT_FROM="alerts@x.com" \
  ALERT_SMTP_HOST="smtp.example.com" ALERT_SMTP_PORT="587" ALERT_SMTP_USE_TLS="true"
run_alert _deliver_alert "SUBJ" "BODY"
smtp_args="$(cat "${CALLS}/curl.args.1")"
assert_contains "${smtp_args}" $'--mail-rcpt\na@x.com' "curl SMTP gets an envelope recipient for the first address"
assert_contains "${smtp_args}" $'--mail-rcpt\nb@y.com' "curl SMTP gets an envelope recipient for the second address"
assert_contains "$(cat "${CALLS}/curl.stdin.1")" "To: a@x.com,b@y.com" "curl SMTP To: header lists every recipient"

# ─── Email and Telegram are additive ──────────────────────────────────────────
clear_alert_env; reset_calls
export ALERT_TO="a@x.com" ALERT_FROM="alerts@x.com" ALERT_SMTP_HOST="smtp.example.com" ALERT_SMTP_PORT="587" \
  ALERT_SMTP_USE_TLS="true" ALERT_TELEGRAM_BOT_TOKEN="123:abc" ALERT_TELEGRAM_CHAT_IDS="42" CURL_MODE=ok
run_alert _deliver_alert "SUBJ" "BODY"
assert_contains "${RUN_OUTPUT}" "Alert email sent via curl SMTP" "email is delivered"
assert_contains "${RUN_OUTPUT}" "Alert sent via Telegram to chat 42" "Telegram is delivered as well"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "no" \
  "no logger fallback when both channels delivered"

# ─── Nothing configured: logger fallback ──────────────────────────────────────
clear_alert_env; reset_calls
run_alert _deliver_alert "SUBJ" "BODY"
assert_eq "$([[ -e "${CALLS}/logger.called" ]] && echo yes || echo no)" "yes" \
  "logger fallback runs when no channel is configured"

test_end || exit 1
