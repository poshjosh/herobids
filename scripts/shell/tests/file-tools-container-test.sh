#!/usr/bin/env bash
# file-tools-container-test.sh — checks of the agent file tools that unit tests cannot cover.
#
# Runs the REAL built tools (dist/tools/*.js) inside the agent image. No stack, no LLM, no
# network. Plan: docs/features/2026/11/15/001-agent-file-tools/plan.md ("Unverified items").
#
# Checks:
#   1. Quota: with AGENT_WORKSPACE_QUOTA_MB set, writes stop with file.quota_exceeded and
#      the message names delete_file. (If a herobids-agent-* container is running, also
#      prints its AGENT_WORKSPACE_QUOTA_MB, which shows the launcher passes it through.)
#   2. chown: edit_file keeps the owner and mode of a file owned by user `agent`.
#   3. Regex: search_files regex works in the image (with timing), and a catastrophic
#      pattern ends with incomplete: true instead of hanging.
#   4. PDF memory: PdfTextExtractor handles a ~900 KiB PDF inside a memory-limited
#      container. Set PDF_FILE=/path/to.pdf to use your own PDF instead of a generated one.
#
# Prerequisite: the agent image is built with the file tools:
#   docker build -f docker/Dockerfile.agent -t herobids-agent:latest .
#   (scripts/shell/run/build-and-run.sh does this)
#
# Env:
#   AGENT_IMAGE   Agent image (default: herobids-agent:latest)
#   PDF_FILE      Optional PDF to extract in check 4
#   PDF_MEM       Container memory limit for check 4 (default: 512m, the free/starter tier)
#   REGEX_MAX_MS  Max accepted wall time for the catastrophic regex search (default: 15000)
#
# Exit code: 0 if all checks pass, 1 if any check fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_IMAGE="${AGENT_IMAGE:-herobids-agent:latest}"
PDF_MEM="${PDF_MEM:-512m}"
REGEX_MAX_MS="${REGEX_MAX_MS:-15000}"
WORKER_DIR="/app/apps/worker"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; }

command -v docker > /dev/null || { echo "docker is required" >&2; exit 1; }
command -v jq > /dev/null || { echo "jq is required" >&2; exit 1; }
if ! docker image inspect "${AGENT_IMAGE}" > /dev/null 2>&1; then
  echo "Agent image '${AGENT_IMAGE}' not found. Build it first:" >&2
  echo "  docker build -f docker/Dockerfile.agent -t herobids-agent:latest ." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
HARNESS="${TMP}/verify-harness.mjs"

# The harness runs inside the image next to the built worker, so its imports resolve.
cat > "${HARNESS}" <<'JS'
import { filesystemTools } from './dist/tools/filesystem.js';
import { searchFilesTool } from './dist/tools/search-files.js';

const mode = process.argv[2];
const ctx = { agentId: 'verify' };
const tools = Object.fromEntries([...filesystemTools, searchFilesTool].map((t) => [t.name, t]));
const emit = (value) => console.log('RESULT:' + JSON.stringify(value));

// Same validation the agent loop does before calling a tool.
async function call(name, params) {
  const tool = tools[name];
  if (!tool) throw new Error('unknown tool ' + name);
  return tool.execute(tool.parametersSchema.parse(params), ctx);
}

if (mode === 'quota') {
  const chunk = 'x'.repeat(15000);
  let first = null;
  let writes = 0;
  for (let i = 0; i < 1000 && !first; i++) {
    const r = await call('write_file', { path: `fill/f${i}.txt`, content: chunk });
    if (r.success) writes++; else first = r;
  }
  emit({ writes, error: first?.error ?? null, errorCode: first?.errorCode ?? null });
} else if (mode === 'regex') {
  await call('write_file', { path: 'notes/a.txt', content: 'alpha\nbeta 123\ngamma 456\n' });
  let t = Date.now();
  const ok = await call('search_files', { path: 'notes', query: '[0-9]{3}', regex: true });
  const okMs = Date.now() - t;
  await call('write_file', { path: 'evil/a.txt', content: 'a'.repeat(40) + 'b\n' });
  t = Date.now();
  const bad = await call('search_files', { path: 'evil', query: '(a+)+$', regex: true });
  const badMs = Date.now() - t;
  emit({
    okMatches: ok.data?.matches?.length ?? 0, okMs,
    badIncomplete: bad.data?.incomplete ?? null, badReason: bad.data?.incompleteReason ?? null, badMs,
  });
} else if (mode === 'edit') {
  const r = await call('edit_file', { path: 't.txt', oldText: 'hi', newText: 'ho' });
  emit({ success: r.success, error: r.error ?? null });
} else if (mode === 'pdf') {
  const { PdfTextExtractor } = await import('@herobids/documents/document-text-extractors');
  const { readFileSync } = await import('node:fs');
  let body;
  if (process.env.PDF_PATH) {
    body = readFileSync(process.env.PDF_PATH);
  } else {
    // Minimal uncompressed multi-page PDF, grown to about 900 KiB.
    const target = 900 * 1024;
    const pages = [];
    let size = 400;
    for (let p = 0; size < target; p++) {
      let s = 'BT /F1 9 Tf 30 780 Td 11 TL\n';
      for (let l = 0; l < 60; l++) {
        s += `(Page ${p} line ${l} lorem ipsum dolor sit amet consectetur adipiscing elit sed do) '\n`;
      }
      s += 'ET';
      pages.push(s);
      size += s.length + 120;
    }
    const objs = [];
    const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((s, i) => {
      const pid = 4 + i * 2;
      objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pid + 1} 0 R >>`;
      objs[pid + 1] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
    });
    let out = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    body = Buffer.from(out, 'latin1');
  }
  const t = Date.now();
  const r = await new PdfTextExtractor().extract({ body, mimeType: 'application/pdf', filename: 'verify.pdf' });
  emit({
    pdfBytes: body.length, ok: r.ok, chars: r.ok ? r.data.extractedText?.length ?? 0 : 0,
    error: r.ok ? null : r.error?.message ?? 'failed', ms: Date.now() - t,
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  });
} else {
  throw new Error('unknown mode ' + mode);
}
JS

# result_of <docker output> -> the JSON after the last RESULT: marker (empty if none)
result_of() { printf '%s\n' "$1" | sed -n 's/^RESULT://p' | tail -n 1; }

# run_harness <mode> [docker run args...]  (sets OUT, EXIT)
run_harness() {
  local mode="$1"; shift
  EXIT=0
  OUT="$(docker run --rm --entrypoint node \
    -v "${HARNESS}:${WORKER_DIR}/verify-harness.mjs:ro" -w "${WORKER_DIR}" \
    -e AGENT_WORKSPACE_ROOT=/workspace \
    "$@" "${AGENT_IMAGE}" verify-harness.mjs "${mode}" 2>&1)" || EXIT=$?
}

echo "━━━ Check 1: workspace quota inside the container ━━━"
run_harness quota -e AGENT_WORKSPACE_QUOTA_MB=2
R="$(result_of "${OUT}")"
if [ -z "${R}" ]; then
  fail "quota harness produced a result" "exit ${EXIT}: $(printf '%s' "${OUT}" | tail -n 5)"
else
  code="$(jq -r '.errorCode' <<< "${R}")"; msg="$(jq -r '.error' <<< "${R}")"; writes="$(jq -r '.writes' <<< "${R}")"
  [ "${code}" = "file.quota_exceeded" ] && pass "writes stop with file.quota_exceeded after ${writes} writes (2 MiB quota)" \
    || fail "writes stop with file.quota_exceeded" "got code=${code} writes=${writes}"
  [[ "${msg}" == *delete_file* ]] && pass "message names delete_file" || fail "message names delete_file" "${msg}"
  [ "${writes}" -ge 100 ] && [ "${writes}" -le 140 ] && pass "quota applied near 2 MiB (${writes} x 15,000 chars)" \
    || fail "quota applied near 2 MiB" "writes=${writes}, expected about 130"
fi
LIVE="$(docker ps --filter 'name=herobids-agent-' --format '{{.Names}}' | head -n 1)"
if [ -n "${LIVE}" ]; then
  LIVE_Q="$(docker exec "${LIVE}" printenv AGENT_WORKSPACE_QUOTA_MB 2>/dev/null || true)"
  [ -n "${LIVE_Q}" ] && pass "running ${LIVE} has AGENT_WORKSPACE_QUOTA_MB=${LIVE_Q} (launcher passes it)" \
    || fail "running ${LIVE} has AGENT_WORKSPACE_QUOTA_MB" "variable not set; was it launched before this change?"
else
  echo "  - no running herobids-agent-* container; launcher pass-through not checked (start an agent, rerun)"
fi

echo "━━━ Check 2: edit_file keeps owner and mode ━━━"
EXIT=0
OUT="$(docker run --rm --entrypoint sh \
  -v "${HARNESS}:${WORKER_DIR}/verify-harness.mjs:ro" -w "${WORKER_DIR}" \
  -e AGENT_WORKSPACE_ROOT=/workspace "${AGENT_IMAGE}" -c '
    echo hi > /workspace/t.txt && chown agent:agent /workspace/t.txt && chmod 640 /workspace/t.txt
    node verify-harness.mjs edit
    echo "STAT:$(stat -c "%U %a" /workspace/t.txt)"
    echo "TEXT:$(cat /workspace/t.txt)"' 2>&1)" || EXIT=$?
R="$(result_of "${OUT}")"
STAT="$(printf '%s\n' "${OUT}" | sed -n 's/^STAT://p')"
TEXT="$(printf '%s\n' "${OUT}" | sed -n 's/^TEXT://p')"
if [ "$(jq -r '.success' <<< "${R:-null}")" = "true" ]; then pass "edit_file succeeded"; else fail "edit_file succeeded" "exit ${EXIT}: $(printf '%s' "${OUT}" | tail -n 5)"; fi
[ "${TEXT}" = "ho" ] && pass "file content changed" || fail "file content changed" "got '${TEXT}'"
[ "${STAT}" = "agent 640" ] && pass "owner and mode preserved (${STAT})" || fail "owner and mode preserved" "got '${STAT}', expected 'agent 640'"

echo "━━━ Check 3: search_files regex in the image ━━━"
run_harness regex
R="$(result_of "${OUT}")"
if [ -z "${R}" ]; then
  fail "regex harness produced a result" "exit ${EXIT}: $(printf '%s' "${OUT}" | tail -n 5)"
else
  [ "$(jq -r '.okMatches' <<< "${R}")" = "2" ] && pass "regex finds 2 matches ($(jq -r '.okMs' <<< "${R}") ms incl. worker start)" \
    || fail "regex finds 2 matches" "${R}"
  [ "$(jq -r '.badIncomplete' <<< "${R}")" = "true" ] && pass "catastrophic pattern returns incomplete (reason $(jq -r '.badReason' <<< "${R}"))" \
    || fail "catastrophic pattern returns incomplete" "${R}"
  [ "$(jq -r '.badMs' <<< "${R}")" -le "${REGEX_MAX_MS}" ] && pass "catastrophic pattern ended in $(jq -r '.badMs' <<< "${R}") ms (limit ${REGEX_MAX_MS})" \
    || fail "catastrophic pattern ended in time" "${R}"
fi

echo "━━━ Check 4: PDF extraction memory (limit ${PDF_MEM}) ━━━"
PDF_ARGS=(--memory "${PDF_MEM}" --memory-swap "${PDF_MEM}")
if [ -n "${PDF_FILE:-}" ]; then
  [ -f "${PDF_FILE}" ] || { echo "PDF_FILE not found: ${PDF_FILE}" >&2; exit 1; }
  PDF_ARGS+=(-v "${PDF_FILE}:/tmp/verify.pdf:ro" -e PDF_PATH=/tmp/verify.pdf)
fi
run_harness pdf "${PDF_ARGS[@]}"
R="$(result_of "${OUT}")"
if [ -z "${R}" ]; then
  fail "PDF extracted within ${PDF_MEM}" "exit ${EXIT} (137 means out of memory): $(printf '%s' "${OUT}" | tail -n 3)"
else
  if [ "$(jq -r '.ok' <<< "${R}")" = "true" ] && [ "$(jq -r '.chars' <<< "${R}")" -gt 0 ]; then
    pass "extracted $(jq -r '.chars' <<< "${R}") chars from $(jq -r '.pdfBytes' <<< "${R}") bytes in $(jq -r '.ms' <<< "${R}") ms; peak RSS $(jq -r '.maxRssMiB' <<< "${R}") MiB"
  else
    fail "PDF extracted within ${PDF_MEM}" "${R}"
  fi
fi

echo
echo "Passed: ${PASS}  Failed: ${FAIL}"
[ "${FAIL}" -eq 0 ]
