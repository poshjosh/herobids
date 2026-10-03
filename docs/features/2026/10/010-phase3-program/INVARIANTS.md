# Phase 3 Program — INVARIANTS (assert, don't deliberate)

**Status:** living. Checked at every task boundary and again at closeout (G8).

The program `ENTRYPOINT.md §4` invariants are prose, so "did I break one" was a
judgment call every time. These are the Phase-3-relevant ones expressed as
**assertions with the command that checks them**. Run them; don't reason about
them.

Paths are relative to each repo root. `hb` = `~/dev_ai/herobids`,
`tt` = `~/dev_ai/traderton`, `ts` = `~/dev_ai/traderton-skills`.

---

## I1 — No backend-identity branch in generic code

ADR 015 §5: no `if` branch may recognise a specific backend identity inside
generic registration, dispatch or visibility code.

```sh
# In hb. Expect ZERO hits in generic registration/dispatch/visibility paths.
# Hits inside packages/domain/src/trading/** are Step 14/15 scope, not this phase.
rg -n "'traderton'|\"traderton\"|=== *'trading'|!== *'trading'" \
  apps/api/src/routes/skills.ts \
  apps/api/src/**/provider-catalog.ts \
  apps/api/src/**/agent-runtime-descriptor.ts \
  apps/worker/src/agent.ts \
  apps/worker/src/**/runtime-composition.ts \
  apps/worker/src/**/agent-capabilities.ts
```

**Pass:** zero hits after T3.2. Before T3.2 this is the inventory of work to do —
record the count at T0.2 as a baseline and drive it to zero.

## I2 — Nothing above the seam knows a transport

```sh
# In hb. Expect ZERO: no orchestration file imports a transport implementation.
rg -n "RestTransport|McpTransport" packages/domain/src/external-backend/ \
  | rg -v "transports/|index.ts|\.test\.ts"
```

**Pass:** transport names appear only inside the transports directory and the one
composition point. If an orchestration file names a transport, something leaked.

## I3 — The seam is not exported

```sh
# In hb. The seam interface must NOT appear in the package's public surface.
rg -n "Transport" packages/domain/package.json
rg -n "export .*Transport" packages/domain/src/external-backend/index.ts
```

**Pass:** zero hits. Rationale: redirecting the seam later must not be a breaking
change for its ~32 type-level importers.

## I4 — The REST invocation bytes are frozen

Step 10 §5. The acceptance test is behavioural, not a grep.

```sh
# In hb — must pass UNMODIFIED after the rename.
pnpm --filter @herobids/domain exec vitest run src/external-backend/sign.test.ts
# In hb AND tt — the shared vectors, with matching fixture digests.
pnpm --filter @herobids/domain exec vitest run -t "signing vectors"
# (tt) equivalent vector test in packages/boundary
```

**Pass:** green in both repos, fixture digests equal to the values recorded in
`SEAM.md`.

**Stop condition:** if making MCP work requires editing `sign.ts` canonical-string
construction, header names or body serialization — **stop and re-open ADR 016**
(ENTRYPOINT §6 hard stop 3). `McpTransport` reuses these; it does not refactor
them.

## I5 — Idempotency key and requestId are first-class seam inputs

```sh
# In hb. Both fields must appear in the seam's input type.
rg -n "requestId|idempotencyKey" packages/domain/src/external-backend/transports/*.ts
```

**Pass:** both present on every transport's input. A seam that drops them bakes
the CF-1 defect into the abstraction and makes D15's `in_progress` resolution
impossible.

## I6 — The descriptor is the sole schema authority (D16 / DT4)

```sh
# In hb. tool name/description/inputSchema must be sourced from the verified
# descriptor only. Expect ZERO hits where tools/list feeds a schema.
# __fixtures__/ is excluded: fixture rule text is data, not code.
rg -n --glob '!**/__fixtures__/**' "tools/list|toolsList" apps/ packages/ | rg -i "schema|inputSchema"
```

**Pass:** zero hits, or hits only in cross-check/comparison code (never
assignment into a `ToolDefinition`). Rationale: MCP tool descriptions enter the
model context directly; an unverified `tools/list` from an order-placing backend
is a tool-poisoning surface.

## I7 — No strict-mode escape hatches introduced

```sh
# In hb and tt, against the branch diff.
git diff main...HEAD -- '*.ts' | rg -n "^\+.*(\bas unknown as\b|@ts-ignore|@ts-expect-error|: *any\b)"
```

**Pass:** zero additions. Repo rule: do not bypass TypeScript strict checks.

## I8 — Local boundary only (G3 — run BEFORE any test suite)

```sh
env | grep TRADERTON_                      # expect: no output
rg -n "TRADERTON_BOUNDARY_URL" .env        # in hb: expect no match
echo "${BOUNDARY_BASE_URL:-unset}"         # expect: unset
```

**Pass:** all three clear. If any is set, **STOP and report** — the suites would
point at staging. `docker/xstack.override.yml` makes `TRADERTON_BOUNDARY_URL`
overridable, and `traderton/scripts/shell/tests/run-live-boundary.sh` **defaults
to `https://api.staging.traderton.com`** when `BOUNDARY_BASE_URL` is unset and
invokes `submit_decision`. Never run that script.

## I9 — Zero pushes, branch commits only (D20)

```sh
for r in ~/dev_ai/herobids ~/dev_ai/traderton ~/dev_ai/traderton-skills; do
  git -C "$r" rev-parse --abbrev-ref HEAD      # expect the phase3-* branch
  git -C "$r" log --oneline origin/main..HEAD  # expect local-only commits
done
```

**Pass:** on a `phase3-*` branch in each repo, never on `main`, with no commit
reachable from any remote ref that was not there at baseline.

## I10 — The Step-12 stub descriptor is gone (after T4.2)

```sh
# In hb. Expect ZERO after T4.2.
rg -n -i "stub.?descriptor|STUB_DESCRIPTOR" apps/ packages/ config/
```

**Pass:** zero hits. A run that leaves the stub in place is not done (G4).

## I11 — `.env.example` twins are current

Repo rule: when you add or change an environment variable, update the matching
`.example` in the SAME change.

```sh
# In hb. Every process.env key read should exist in the matching .example.
rg -on "process\.env\.[A-Z0-9_]+" apps/ packages/ config/ | sort -u
rg -n "^[A-Z0-9_]+=" .env.example | cut -d= -f1 | sort -u
```

**Pass:** no env key read by code that is absent from its `.example` twin.

## I12 — Genericity (the real test of the phase)

Not a grep. A written answer, recorded at closeout:

> **Could a second, unrelated backend be registered with ZERO platform code
> change?** Name the exact steps an operator would take, and name anything that
> would still require a code change.

**Pass:** the answer is "yes, via config + a signed descriptor", and the
remaining-code-change list is empty. If the list is non-empty, every item is
either fixed or recorded as a carried-forward obligation with a reason.

Rationale: if trading is the only thing the mechanism ever serves, this phase
produced a monolith in two repos with a renamed seam. This is the invariant the
strategic objective actually rests on.

---

## Recording

At T0.2 record the baseline value of every invariant above (I1's count will be
non-zero; I10 is N/A until T4.2). At each task boundary re-run the ones the task
could affect. At closeout (G8) all must be green or carry an explicit recorded
exception.
