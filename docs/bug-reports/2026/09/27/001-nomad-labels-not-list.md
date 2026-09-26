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

Serialize `labels` as `["k=v", ...]` (`Object.entries(...).map`) and change the
`NomadJobSpec.Config.labels` type to `string[]`. `env` stays a string→string map
(correct for the JSON API). Added a regression test asserting the array shape.

### Files

- `apps/worker/src/agents/nomad-runtime-adapter.ts` — labels type + serialization; exported `NomadJobSpec`/`buildNomadJobSpec`
- `apps/worker/src/agents/nomad-runtime-adapter.test.ts` — NEW (3 tests)

## Verification

- vitest 3/3 pass; `tsc --build` clean.

## Related

- `docs/features/2026/09/27/001-nomad-labels-map-should-be-list/000-analysis.md`
- Full chain: `docs/features/2026/09/26/001-ghcr-agent-image-distribution/000-analysis.md`
- `docs/bug-reports/2026/09/26/001-*`, `002-*`