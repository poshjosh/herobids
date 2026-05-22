# TODO

- [ ] After monorepo scaffold: add `eslint-plugin-boundaries` if deep-path imports across packages become a recurring review issue. Until then, pnpm workspace resolution + clean barrel exports (`src/index.ts`) enforce dependency direction at build time.
- [ ] After monorepo scaffold: move §21 Conventions (Result type, error code naming) from the design doc into `packages/domain/README.md` or a top-level `docs/conventions.md` — somewhere that lives next to the code, not buried in a feature proposal.
- [ ] When implementing venue adapters: apply rate-limiting lessons from `docs/lessons/rate-limiting-guide.md` — never nest rate-limited calls, short TTL for empty/error cache entries, staleness max on cached prices, self-healing pressure backoff, and check whether provider limits are per-IP or per-key before sharing counters.
