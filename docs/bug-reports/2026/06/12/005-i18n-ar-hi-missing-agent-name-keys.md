# 005 — Arabic and Hindi i18n catalogs missing `agents.create.name` and `agents.create.namePlaceholder`

**Date:** 2026-06-12  
**Severity:** Medium (blocks unit test suite)  
**Affected files:**
- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`

## Symptoms

The `locale catalogs > keep Arabic and Hindi keys aligned with English` unit test failed:

```
AssertionError: expected [ …(444) ] to deeply equal [ …(446) ]
- "agents.create.name"
- "agents.create.namePlaceholder"
```

## Root Cause

Two new i18n keys were added to `en.ts` as part of the agent name field feature:
- `'agents.create.name'`
- `'agents.create.namePlaceholder'`

The corresponding entries were not added to `ar.ts` or `hi.ts`.

## Fix Applied

Added the two missing keys to both `ar.ts` and `hi.ts` with translated values:

| Key | Arabic | Hindi |
|---|---|---|
| `agents.create.name` | `الاسم` | `नाम` |
| `agents.create.namePlaceholder` | `مثلاً market-watch-01` | `उदा. market-watch-01` |
