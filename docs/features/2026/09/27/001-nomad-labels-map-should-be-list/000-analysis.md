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
- `env`: a **task-level `Env`** map (sibling of `Config`), NOT inside the docker
  driver `config` block. Placing `env` inside `config` produced
  `Invalid label: No argument or block type is named "env"`.

Both defects were latent: `labels` was first a JS object, then `string[]`; and
`env` was nested inside `Config`. Each failed client-side validation.

This is a **latent code bug** in the Nomad adapter. It was never exercised
because every prior layer (private NIC down → `__PRIVATE_IP__` → stale ACL →
UFW bridge → missing namespace → image never on the node) failed before the job
ever got placed and validated on a client node.

## The fix

1. `labels` → a list of maps: `[{ ...config.labels, 'herobids.managed-by': 'nomad' }]`.
2. `env` → move out of `Config` to the task-level `Env` field.

## Files

- `apps/worker/src/agents/nomad-runtime-adapter.ts` — `NomadJobSpec` Task `Env`
  + `Config.labels` type + `buildNomadJobSpec` serialisation.
- `apps/worker/src/agents/nomad-runtime-adapter.test.ts` — NEW (3 tests).

## Notes

- No test previously covered the Nomad job spec shape (`nomad-runtime-adapter.ts`
  had no `.test.ts`). Added coverage asserting `labels` is `[]map[string]string`
  and `env` is task-level `Env`, not in `Config`.

## Related

- Full incident chain → see `docs/features/2026/09/26/001-ghcr-agent-image-distribution/000-analysis.md`
- Bug reports `docs/bug-reports/2026/09/26/001-*` and `002-*`
- Repo memory `herobids-staging-nomad-investigation.md`