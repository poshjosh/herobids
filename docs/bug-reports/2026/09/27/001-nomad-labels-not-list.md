# Bug Report 001 — Nomad agent job `labels` serialized as a map (driver rejects it)

- **Status:** FIXED (uncommitted, pending deploy)
- **Severity:** High (blocks all agent launches on Nomad)
- **Date:** 2026-09-27
- **Environment:** staging; latent in the Nomad adapter since it was authored (would affect production too)

## Summary

After all infrastructure layers were fixed (private NIC, ACL, UFW, namespace,
GHCR image pull), agent launches still failed with
`Stale agent start detected` ~18s after the Nomad job registered.

The Nomad client (agent node) journal showed the allocation **failed task
validation**, so no container was ever created:

```
3 errors occurred:
 * failed to parse config:
 * Invalid label: No argument or block type is named "env".
 * Incorrect attribute value type: Inappropriate value for attribute "labels": list of map of string required.
```

## Root Cause

`apps/worker/src/agents/nomad-runtime-adapter.ts` → `buildNomadJobSpec` emitted
`Config.labels` as a JS object (`Record<string,string>`), but Nomad's Docker
driver requires `labels` as a **list of strings** (`["key=value", ...]`). The
malformed `labels` made the whole `Config` block fail HCL parse, with the nested
`env` key reported as an unrelated "Invalid label".

This was a latent code bug never exercised until the allocation finally reached
a client node for validation (all prior infrastructure failures happened before
placement).

## Fix

Two corrections to `buildNomadJobSpec` in `nomad-runtime-adapter.ts`:

1. `labels` → list of maps `[{ ...labels, 'herobids.managed-by': 'nomad' }]`
   (Nomad v1.9 docker driver wants `[]map[string]string`, NOT a flat map and NOT
   `[]string` `"k=v"`).
2. `env` → moved out of `Config` to a task-level `Env` field (Nomad rejects `env`
   inside the docker `config` block).

Added a regression test asserting both shapes.

> Note: the first `labels` iteration used `[]string` (`"k=v"`) and was rejected
> with `element 0: map of string required`; the second leftover error was `env`
> inside `Config` → moved to task-level `Env`.

### Files

- `apps/worker/src/agents/nomad-runtime-adapter.ts` — labels type + serialization; exported `NomadJobSpec`/`buildNomadJobSpec`
- `apps/worker/src/agents/nomad-runtime-adapter.test.ts` — NEW (3 tests)

## Verification

- vitest 3/3 pass; `tsc --build` clean.

## Related

- `docs/features/2026/09/27/001-nomad-labels-map-should-be-list/000-analysis.md`
- Full chain: `docs/features/2026/09/26/001-ghcr-agent-image-distribution/000-analysis.md`
- `docs/bug-reports/2026/09/26/001-*`, `002-*`