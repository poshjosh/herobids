#!/usr/bin/env bash
# test-setup-autoscale-env.sh — HCLOUD_TOKEN reaches the autoscale units via autoscale.env.
#
# Runs the real setup-autoscale-env.sh in a copied layout with ssh/scp/systemctl
# stubs. The stubs run remote commands under a fake root, so the uploaded file,
# its mode and its contents are checked for real. The environment is cleared and
# the scripts are copied, so the operator's HCLOUD_TOKEN and the gitignored tfvars
# in the working tree are never read. Every token value is synthetic.
#
# Run: bash infra/hetzner/scripts/tests/test-setup-autoscale-env.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
HETZNER_DIR="$(cd "${TESTS_DIR}/../.." && pwd)"
CLOUD_INIT="${HETZNER_DIR}/cloud-init.yaml"
MOCK_BIN="${TEST_TMPDIR}/bin"
REAL_SED="$(command -v sed)"
mkdir -p "${MOCK_BIN}"

# ─── Recording stubs ──────────────────────────────────────────────────────────

# ssh records the call, then runs the remote command under FAKE_ROOT. Only absolute path
# arguments (preceded by a space) are rewritten, so sed expressions keep their text.
# Stdin passes through, so `ssh ... < file` reaches the remote cat.
cat > "${MOCK_BIN}/ssh" <<'EOF'
#!/usr/bin/env bash
echo "ssh $*" >> "${STUB_LOG}"
remote=""
after_host=0
for arg in "$@"; do
  if [[ ${after_host} -eq 1 ]]; then remote="${arg}"; break; fi
  [[ "${arg}" == root@* ]] && after_host=1
done
[[ -n "${remote}" ]] || exit 0
remote="${remote// \/etc\// ${FAKE_ROOT}/etc/}"
remote="${remote// \/opt\// ${FAKE_ROOT}/opt/}"
remote="${remote// \/root\// ${FAKE_ROOT}/root/}"
exec bash -c "${remote}"
EOF

cat > "${MOCK_BIN}/scp" <<'EOF'
#!/usr/bin/env bash
echo "scp $*" >> "${STUB_LOG}"
args=("$@")
n=${#args[@]}
src="${args[n-2]}"
dest="${args[n-1]}"
path="${dest#*:}"
mkdir -p "$(dirname "${FAKE_ROOT}${path}")"
cp "${src}" "${FAKE_ROOT}${path}"
EOF

cat > "${MOCK_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "${STUB_LOG}"
EOF

# The remote tfvars step runs `sed -i EXPR FILE`. BSD sed (macOS) reads EXPR as the backup
# suffix, so the shim passes an explicit suffix on both platforms and removes the backup.
cat > "${MOCK_BIN}/sed" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-i" ]]; then
  shift
  "${STUB_REAL_SED}" -i.stubbak "$@" || exit 1
  rm -f "${!#}.stubbak"
  exit 0
fi
exec "${STUB_REAL_SED}" "$@"
EOF

chmod +x "${MOCK_BIN}/ssh" "${MOCK_BIN}/scp" "${MOCK_BIN}/systemctl" "${MOCK_BIN}/sed"

# ─── Helpers ──────────────────────────────────────────────────────────────────

# perm_of <path> — octal mode (GNU stat, then BSD stat).
perm_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# inode_of <path> — inode number (GNU stat, then BSD stat).
inode_of() { stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"; }

# EXTRA_ENVS holds NAME=value overrides for the next run_setup call. Callers set and reset it
# in the calling shell, because run_setup runs inside $(...).
EXTRA_ENVS=()

# make_layout <name> <tfvars body> — a copy of the scripts under a synthetic hetzner/
# root, so TF_DIR and the staging tfvars are fakes.
make_layout() {
  local layout="${TEST_TMPDIR}/$1"
  mkdir -p "${layout}/hetzner/scripts" "${layout}/remote" "${layout}/remote/opt/herobids/infra/hetzner"
  cp "${SCRIPTS_DIR}/setup-autoscale-env.sh" "${SCRIPTS_DIR}/_ssh_opts.sh" "${layout}/hetzner/scripts/"
  # _ssh_opts.sh aborts under pipefail when tfvars lacks ssh_public_key_path, and real
  # tfvars always define it, so the fake one points at a synthetic key file.
  : > "${layout}/test-key.pub"
  : > "${layout}/test-key"
  printf 'ssh_public_key_path = "%s"\n%s\n' "${layout}/test-key.pub" "$2" > "${layout}/hetzner/staging.tfvars"
  : > "${layout}/calls.log"
  echo "${layout}"
}

# run_setup <layout> <HCLOUD_TOKEN or empty> [args...] — the environment is cleared
# so nothing from the operator's shell leaks in.
run_setup() {
  local layout="$1" token="$2"
  shift 2
  local envs=(
    "PATH=${MOCK_BIN}:/usr/bin:/bin" "HOME=${TEST_TMPDIR}" "HEROBIDS_ENV=staging"
    "FAKE_ROOT=${layout}/remote" "STUB_LOG=${layout}/calls.log" "STUB_REAL_SED=${REAL_SED}"
    "TF_BACKEND_BUCKET=test-bucket-not-real"
    "AWS_ACCESS_KEY_ID=test-aws-key-not-real" "AWS_SECRET_ACCESS_KEY=test-aws-secret-not-real"
  )
  if [[ -n "${token}" ]]; then
    envs+=("HCLOUD_TOKEN=${token}")
  fi
  envs+=(${EXTRA_ENVS[@]+"${EXTRA_ENVS[@]}"})
  : > "${layout}/calls.log"
  env -i "${envs[@]}" bash "${layout}/hetzner/scripts/setup-autoscale-env.sh" "$@" 2>&1
}

# unit_envfiles <unit> — EnvironmentFile= paths of a unit in cloud-init.yaml.
unit_envfiles() {
  awk -v unit="$1" '
    $0 == "  - path: /etc/systemd/system/" unit ".service" { found = 1; next }
    found && /content: \|/ { body = 1; next }
    found && body && /^(  - |[^ ])/ { exit }
    body { print }
  ' "${CLOUD_INIT}" | sed -nE 's/^[[:space:]]*EnvironmentFile=-?//p'
}

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-autoscale-env — HCLOUD_TOKEN is written to autoscale.env (0600)"

LAYOUT="$(make_layout upload 'hcloud_token = "test-token-from-tfvars-not-real"')"
# A pre-existing, world-readable autoscale.env must be replaced, not truncated in place.
mkdir -p "${LAYOUT}/remote/etc/herobids"
printf 'stale\n' > "${LAYOUT}/remote/etc/herobids/autoscale.env"
chmod 0644 "${LAYOUT}/remote/etc/herobids/autoscale.env"
INODE_BEFORE="$(inode_of "${LAYOUT}/remote/etc/herobids/autoscale.env")"
OUT="$(run_setup "${LAYOUT}" test-token-not-real --env staging 203.0.113.10)" && RC=0 || RC=$?
AUTOSCALE_ENV="${LAYOUT}/remote/etc/herobids/autoscale.env"
assert_eq "${RC}" "0" "upload: exits 0"
assert_eq "$(grep -c '^HCLOUD_TOKEN=test-token-not-real$' "${AUTOSCALE_ENV}" || true)" "1" \
  "upload: autoscale.env carries HCLOUD_TOKEN from the environment"
assert_eq "$(grep -c '^HCLOUD_TOKEN=test-token-from-tfvars' "${AUTOSCALE_ENV}" || true)" "0" \
  "upload: environment wins over the tfvars fallback"
assert_eq "$(perm_of "${AUTOSCALE_ENV}")" "600" "upload: autoscale.env is mode 0600"
assert_neq "$(inode_of "${AUTOSCALE_ENV}")" "${INODE_BEFORE}" \
  "upload: an existing autoscale.env is replaced by rename, not truncated in place"
assert_contains "$(cat "${LAYOUT}/calls.log")" \
  "umask 077 && cat > /etc/herobids/autoscale.env.tmp && chmod 0600 /etc/herobids/autoscale.env.tmp && mv -f /etc/herobids/autoscale.env.tmp /etc/herobids/autoscale.env" \
  "upload: file is written to a private tmp under umask 077, then renamed into place"
assert_not_contains "${OUT}" "test-token-not-real" "upload: output does not print the token"

test_end || SUITE_FAILED=1

test_begin "setup-autoscale-env — Nomad ACL token is private (0600) and replaces a loose file"

LAYOUT="$(make_layout acl 'hcloud_token = "test-token-from-tfvars-not-real"')"
mkdir -p "${LAYOUT}/remote/etc/nomad.d"
printf 'stale\n' > "${LAYOUT}/remote/etc/nomad.d/acl-token"
chmod 0644 "${LAYOUT}/remote/etc/nomad.d/acl-token"
EXTRA_ENVS=("NOMAD_ACL_TOKEN=test-nomad-token-not-real")
OUT="$(run_setup "${LAYOUT}" test-token-not-real --env staging 203.0.113.10)" && RC=0 || RC=$?
EXTRA_ENVS=()
ACL_TOKEN="${LAYOUT}/remote/etc/nomad.d/acl-token"
assert_eq "${RC}" "0" "acl: exits 0"
assert_eq "$(perm_of "${ACL_TOKEN}")" "600" "acl: a pre-existing 0644 acl-token is replaced with mode 0600"
assert_eq "$(cat "${ACL_TOKEN}")" "test-nomad-token-not-real" "acl: acl-token carries NOMAD_ACL_TOKEN"
assert_contains "$(cat "${LAYOUT}/calls.log")" \
  "umask 077 && rm -f /etc/nomad.d/acl-token && cat > /etc/nomad.d/acl-token && chmod 0600 /etc/nomad.d/acl-token" \
  "acl: umask 077 precedes the write and chmod 0600 follows it"
assert_not_contains "${OUT}" "test-nomad-token-not-real" "acl: output does not print the token"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-autoscale-env — tfvars fallback for HCLOUD_TOKEN"

LAYOUT="$(make_layout fallback 'hcloud_token = "test-token-from-tfvars-not-real"')"
OUT="$(run_setup "${LAYOUT}" "" --env staging 203.0.113.10)" && RC=0 || RC=$?
AUTOSCALE_ENV="${LAYOUT}/remote/etc/herobids/autoscale.env"
assert_eq "${RC}" "0" "fallback: exits 0 without HCLOUD_TOKEN in the environment"
assert_eq "$(grep -c '^HCLOUD_TOKEN=test-token-from-tfvars-not-real$' "${AUTOSCALE_ENV}" || true)" "1" \
  "fallback: autoscale.env carries hcloud_token from staging.tfvars"
assert_eq "$(perm_of "${AUTOSCALE_ENV}")" "600" "fallback: autoscale.env is mode 0600"

TFVARS_REMOTE="${LAYOUT}/remote/opt/herobids/infra/hetzner/staging.tfvars"
assert_eq "$(perm_of "${TFVARS_REMOTE}")" "600" "fallback: uploaded tfvars is mode 0600"
assert_contains "$(cat "${TFVARS_REMOTE}")" 'hcloud_token = "test-token-from-tfvars-not-real"' \
  "fallback: uploaded tfvars carries the staging values"
assert_eq "$(grep -c '^scp .*staging.tfvars' "${LAYOUT}/calls.log" || true)" "0" \
  "fallback: tfvars is streamed over ssh, not copied with scp (no default-umask window)"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-autoscale-env — dry-run redacts every secret"

LAYOUT="$(make_layout dry-run 'hcloud_token = "test-token-from-tfvars-not-real"')"
EXTRA_ENVS=("NOMAD_ACL_TOKEN=test-nomad-token-not-real")
OUT="$(run_setup "${LAYOUT}" test-token-not-real --env staging --dry-run 203.0.113.10)" && RC=0 || RC=$?
EXTRA_ENVS=()
assert_eq "${RC}" "0" "dry-run: exits 0"
assert_contains "${OUT}" "HCLOUD_TOKEN=<redacted>" "dry-run: shows the HCLOUD_TOKEN line as redacted"
assert_contains "${OUT}" "AWS_SECRET_ACCESS_KEY=<redacted>" "dry-run: shows the AWS secret line as redacted"
assert_contains "${OUT}" "NOMAD_TOKEN=<redacted>" "dry-run: shows the Nomad token line as redacted"
assert_not_contains "${OUT}" "test-token-not-real" "dry-run: does not print the token"
assert_not_contains "${OUT}" "test-aws-secret-not-real" "dry-run: does not print the AWS secret"
assert_contains "${OUT}" "AWS_ACCESS_KEY_ID=<redacted>" "dry-run: shows the AWS access key line as redacted"
assert_not_contains "${OUT}" "test-aws-key-not-real" "dry-run: does not print the AWS access key ID"
assert_not_contains "${OUT}" "test-nomad-token-not-real" "dry-run: does not print the Nomad token"
assert_eq "$(cat "${LAYOUT}/calls.log")" "" "dry-run: makes no ssh or scp calls"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-autoscale-env — refuses a missing or unsafe HCLOUD_TOKEN"

LAYOUT="$(make_layout missing 'region = "eu-central"')"
OUT="$(run_setup "${LAYOUT}" "" --env staging 203.0.113.10)" && RC=0 || RC=$?
assert_neq "${RC}" "0" "missing: exits non-zero"
assert_contains "${OUT}" "HCLOUD_TOKEN is not set" "missing: names HCLOUD_TOKEN"
assert_eq "$(cat "${LAYOUT}/calls.log")" "" "missing: makes no ssh or scp calls"

LAYOUT="$(make_layout unsafe 'hcloud_token = "test-token-from-tfvars-not-real"')"
OUT="$(run_setup "${LAYOUT}" 'test-token;rm-not-real' --env staging 203.0.113.10)" && RC=0 || RC=$?
assert_neq "${RC}" "0" "unsafe: exits non-zero"
assert_contains "${OUT}" "cannot be written to autoscale.env safely" "unsafe: explains the rejection"
assert_not_contains "${OUT}" "rm-not-real" "unsafe: does not echo the value"
assert_eq "$(cat "${LAYOUT}/calls.log")" "" "unsafe: makes no ssh or scp calls"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

# expect_refused <NAME> <kind> <value> — the run must fail, name NAME without echoing the
# value, and make no ssh or scp calls.
REFUSE_N=0
expect_refused() {
  local name="$1" kind="$2" value="$3" layout out rc
  REFUSE_N=$((REFUSE_N + 1))
  layout="$(make_layout "refuse-${REFUSE_N}" 'hcloud_token = "test-token-from-tfvars-not-real"')"
  EXTRA_ENVS=("${name}=${value}")
  out="$(run_setup "${layout}" "" --env staging 203.0.113.10)" && rc=0 || rc=$?
  EXTRA_ENVS=()
  assert_neq "${rc}" "0" "${name} ${kind}: exits non-zero"
  assert_contains "${out}" "${name} contains characters that cannot be written to autoscale.env safely" \
    "${name} ${kind}: names the variable"
  assert_not_contains "${out}" "test-value" "${name} ${kind}: does not echo the value"
  assert_eq "$(cat "${layout}/calls.log")" "" "${name} ${kind}: makes no ssh or scp calls"
}

test_begin "setup-autoscale-env — refuses a newline or quote in any value written to autoscale.env"

for name in HCLOUD_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TF_BACKEND_BUCKET \
  TF_BACKEND_REGION TF_BACKEND_DYNAMODB_TABLE NOMAD_ACL_TOKEN; do
  expect_refused "${name}" "newline" "test-value"$'\n'"INJECTED-not-real=1"
  expect_refused "${name}" "quote" 'test-value"QUOTED-not-real'
done

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-autoscale-env — the token reaches the scale units (static)"

for unit in nomad-autoscale nomad-scale-in nomad-placement-failure-watcher; do
  assert_contains "$(unit_envfiles "${unit}")" "/etc/herobids/autoscale.env" \
    "${unit}: EnvironmentFile includes autoscale.env"
done
assert_contains "$(cat "${SCRIPTS_DIR}/capacity-inventory.sh")" 'HCLOUD_TOKEN:-' \
  "capacity-inventory.sh reads HCLOUD_TOKEN from the unit environment"
assert_eq "$(grep -c 'HCLOUD_TOKEN' "${SCRIPTS_DIR}/render-autoscale-settings.sh" || true)" "0" \
  "the settings allowlist never carries HCLOUD_TOKEN"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'mv -f /etc/herobids/autoscale.env.tmp /etc/herobids/autoscale.env' \
  "the upload renames a private tmp file into place (tmp+mv)"
assert_not_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'cat > /etc/herobids/autoscale.env ' \
  "the target autoscale.env is never written in place"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'rm -f /etc/herobids/autoscale.env.tmp && umask 077' \
  "the autoscale.env tmp is removed before the private write (cat > keeps a stale tmp's mode)"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'rm -f ${REMOTE_TFVARS}.tmp && umask 077' \
  "the tfvars tmp is removed before the private write (cat > keeps a stale tmp's mode)"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  '|| { rm -f /etc/herobids/autoscale.env.tmp; false; }' \
  "the autoscale.env tmp is removed on the failure path"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  '|| { rm -f ${REMOTE_TFVARS}.tmp; false; }' \
  "the tfvars tmp is removed on the failure path"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'umask 077 && rm -f /etc/nomad.d/acl-token && cat > /etc/nomad.d/acl-token && chmod 0600 /etc/nomad.d/acl-token' \
  "the Nomad ACL token is written under umask 077, after rm -f, and chmod 0600 follows"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  "s|~/.ssh/|/etc/herobids/|g" \
  "the server-side tfvars key paths point at /etc/herobids (ProtectHome hides /root)"
assert_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  'scp ${SSH_OPTS} "${SSH_PUB_KEY_PATH}" "root@${SERVER_IP}:/etc/herobids/' \
  "the SSH public key is uploaded to /etc/herobids"
assert_not_contains "$(cat "${SCRIPTS_DIR}/setup-autoscale-env.sh")" \
  '/root/.ssh' \
  "setup-autoscale-env.sh never writes keys under /root"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ setup-autoscale-env suite complete ═══"
exit "${SUITE_FAILED:-0}"
