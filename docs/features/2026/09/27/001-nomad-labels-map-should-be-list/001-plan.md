# Plan — Fix Nomad agent job `labels` serialization (map → list of maps)

**Status:** implemented (uncommitted)
**Date:** 2026-09-27
**Parent:** `000-analysis.md`

## Goal

Make the Nomad docker task spec valid so agent allocations pass client-side
validation and actually start on the client node, instead of failing with
`Stale agent start detected`.

## Change

1. `apps/worker/src/agents/nomad-runtime-adapter.ts`
   - `NomadJobSpec.Config.labels` type: `Record<string,string>` → `Array<Record<string,string>>`.
   - `buildNomadJobSpec`: serialize `labels` as `[{ ...config.labels, 'herobids.managed-by': 'nomad' }]`.
   - Exported `NomadJobSpec` and `buildNomadJobSpec` for testability.

2. `apps/worker/src/agents/nomad-runtime-adapter.test.ts` (NEW)
   - Asserts `labels` is a list of maps (Nomad docker driver `[]map[string]string`),
     `env` remains a string→string map, and image/namespace flow through.

## Verification

- `pnpm --filter @herobids/worker exec vitest run ...nomad-runtime-adapter.test.ts` → 3/3.
- `pnpm --filter @herobids/worker run build` → clean tsc.

## Note

Nomad v1.9 docker driver `labels` = `[]map[string]string` (JSON form of HCL
`labels { key = value }` blocks), NOT `[]string`. The first iteration used
`[]string` `"k=v"` and was rejected with `element 0: map of string required`;
corrected to a list of one map.

## Deploy note

The running worker must be rebuilt + redeployed for the fix to take effect
(`deploy.sh`), and a retry of starting `thyper`/`tintel` should then place an
allocation that actually starts the container and sends a heartbeat.

## Related

- `000-analysis.md`, `docs/bug-reports/2026/09/27/001-nomad-labels-not-list.md`
- Repo memory `herobids-staging-nomad-investigation.md`