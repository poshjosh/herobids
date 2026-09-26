# Analysis — Nomad agent job spec sends `labels` as a map (should be list of strings)

**Status:** analysis; fix follows
**Date:** 2026-09-27

## Symptom

Every agent launch on Nomad fails ~18s after registration:

```
WARN (agent-health-monitor): Stale agent start detected
INFO (nomad-runtime-adapter): Nomad job stopped and purged
```

On the Nomad **client** (agent node) the allocation fails at task validation:

```
3 errors occurred:
 * failed to parse config:
 * Invalid label: No argument or block type is named "env".
 * Incorrect attribute value type: Inappropriate value for attribute "labels": list of map of string required.
```

## Root cause

`apps/worker/src/agents/nomad-runtime-adapter.ts` → `buildNomadJobSpec` emits the
Docker task `Config` as:

```ts
Config: {
  image: config.image,
  env: config.env,          // Record<string,string>
  labels: dockerLabels,     // Record<string,string>  ← WRONG
  ...
}
```

Nomad's Docker driver expects, via the JSON job API:

- `Config.labels`: a **list of maps** (`[]map[string]string`) — the JSON form of
  HCL `labels { key = "value" }` blocks. NOT a flat map, and NOT a list of
  `"k=v"` strings (the first attempt — that produced
  `element 0: map of string required`).
- `Config.env`: a map `{ "KEY": "value" }` (correct as JSON).

Because `labels` was first a JS object, then a `string[]`, the submitted job spec
failed validation. The whole `Config` block fails HCL parse, with the nested
`env` key reported as an unrelated "Invalid label".

This is a **latent code bug** in the Nomad adapter. It was never exercised
because every prior layer (private NIC down → `__PRIVATE_IP__` → stale ACL →
UFW bridge → missing namespace → image never on the node) failed before the job
ever got placed and validated on a client node.

## The fix

Convert `labels` to a list of maps: `[{ ...config.labels, 'herobids.managed-by': 'nomad' }]`,
matching Nomad's Docker driver contract (`[]map[string]string`). `env` already
maps correctly to a JSON object, so it needs no change.

## Files

- `apps/worker/src/agents/nomad-runtime-adapter.ts` — `NomadJobSpec.Config.labels`
  type + `buildNomadJobSpec` label serialisation.

## Notes

- No test currently covers the Nomad job spec shape (`nomad-runtime-adapter.ts`
  has no `.test.ts`). A focused unit test asserting `labels` is `string[]` of
  `k=v` form should be added to prevent regression.

## Related

- Full incident chain → see `docs/features/2026/09/26/001-ghcr-agent-image-distribution/000-analysis.md`
- Bug reports `docs/bug-reports/2026/09/26/001-*` and `002-*`
- Repo memory `herobids-staging-nomad-investigation.md`