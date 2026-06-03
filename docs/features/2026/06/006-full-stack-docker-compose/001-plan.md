# Full-Stack Docker Compose

## Objective

Add a single Docker Compose-based local runtime for the full product stack and do not consider the work complete until the stack is proven to start and function end to end.

The implementation should ship in two modes:

- a production-style local stack that runs built artifacts and is treated as the canonical whole-product startup path
- a Compose-based development override that uses hot reload for API, worker, and web without replacing the faster host-based pnpm workflow

The production-style stack is the primary goal. The dev-hot-reload Compose path is additive and should reuse the same topology rather than becoming a separate architecture.

## Scope Assumptions

- The base Compose stack includes `postgres`, `redis`, `api`, `worker`, and `web`.
- The base stack runs built artifacts, not watch-mode commands.
- The dev stack is layered on top of the base stack via a Compose override or equivalent mechanism.
- Operator config discipline remains unchanged:
  - `config/default.yaml` remains the self-documenting base
  - container-specific values are injected via environment overrides rather than hard-coded container-only defaults in application code
- Service discovery inside containers must use Compose service names, not `localhost`.
- The stack is not complete until startup, routing, database access, Redis access, and at least one basic web-to-API request are validated against real running containers.
- If the current DB migration workflow is inconsistent, that must be resolved as part of this work rather than worked around manually during validation.

## Implementation Order

### 1. Freeze the container runtime contract

Primary files:

- `docker-compose.yaml`
- new `docker-compose.dev.yaml`
- `config/default.yaml`
- `apps/web/src/lib/config.ts`
- `apps/web/vite.config.ts`
- `apps/api/src/config.ts`
- `apps/worker/src/config.ts`

Changes:

- Define one canonical service topology for local whole-stack startup:
  - `postgres`
  - `redis`
  - `api`
  - `worker`
  - `web`
- Decide container-facing ports, host-facing ports, service names, and health-check expectations up front.
- Define the environment contract for both stack modes, including:
  - `DATABASE_URL`
  - `REDIS_URL`
  - API public/base URLs used by auth
  - web runtime API origin or base URL
- Keep config resolution aligned with the existing operator-config rules instead of introducing ad hoc `process.env` reads in feature code.

Dependency:

- First. Dockerfiles and Compose wiring should follow one fixed runtime contract rather than growing by trial and error.

### 2. Add production-ready Docker build definitions for each app service

Primary files:

- new root or app-scoped Dockerfiles for `api`, `worker`, and `web`
- new `.dockerignore`
- optional shared build helpers if needed

Changes:

- Add Dockerfiles for:
  - API: install workspace deps, build the monorepo artifacts required by the API, run the built server
  - worker: install workspace deps, build the monorepo artifacts required by the worker, run the built worker
  - web: build the Vite app and serve the built output from a production web server or minimal static-server image
- Use multi-stage builds so the runtime images do not include the full TypeScript toolchain unless required.
- Ensure each image can be built from the monorepo root without depending on host-installed artifacts.
- Keep the image contract explicit about working directory, built output path, and startup command.

Dependency:

- Depends on Step 1 because the Dockerfiles should embed the agreed runtime contract and env model.

### 3. Make configuration container-aware without weakening the existing config model

Primary files:

- `config/default.yaml`
- `apps/web/src/lib/config.ts`
- `apps/web/vite.config.ts`
- any relevant config loaders or startup wiring

Changes:

- Keep `config/default.yaml` host-friendly for non-container local development.
- Ensure Compose injects container-correct overrides instead of changing app code to assume Docker-only defaults.
- Replace container-invalid `localhost` assumptions in the Compose path with service-name based values such as:
  - `postgres`
  - `redis`
  - `api`
- For the web app:
  - make the production-style container talk to the API using explicit runtime env
  - make the Compose dev mode proxy to the `api` service instead of `localhost`
- Verify auth URLs remain coherent across browser-visible host ports and in-container service routing.

Dependency:

- Depends on Step 1 and should be finished before stack validation starts.

### 4. Resolve database bootstrap and migration behavior for Compose

Primary files:

- `packages/db/package.json`
- `docker-compose.yaml`
- optional migration helper service or startup script
- related DB docs if command naming must change

Changes:

- Reconcile the current migration command path with the actual DB package scripts.
- Decide whether migrations run via:
  - an explicit one-shot Compose service
  - a documented `docker compose run` command
  - or tightly controlled startup sequencing for the API and worker
- Do not rely on manual host-side migration steps if the goal is a reproducible whole-stack startup.
- Ensure the production-style validation path includes successful schema migration against the Compose Postgres service.

Dependency:

- Depends on Steps 1 to 3 because the migration path needs the container env contract and built artifacts.

### 5. Implement the production-style local stack in Compose

Primary files:

- `docker-compose.yaml`

Changes:

- Extend the current infra-only Compose file into a full local stack.
- Add service definitions, networks, env wiring, dependencies, health checks, and any required volumes.
- Make startup deterministic enough that:
  - Postgres is ready before migrations execute
  - Redis is reachable before API and worker attempt to use it
  - API and worker fail loudly if config is invalid or dependencies are unavailable
  - web is reachable on a stable host port
- Avoid mixing watch-mode mounts into this base stack. This file should represent the production-style local runtime.

Dependency:

- Depends on Steps 2 to 4.

### 6. Add a Compose development override with hot reload

Primary files:

- new `docker-compose.dev.yaml`
- app Dockerfiles if a separate dev target is needed
- `apps/web/vite.config.ts`
- any scripts or env files used by the dev override

Changes:

- Add a dev override that reuses the same services but swaps runtime commands and mount strategy:
  - API runs `tsx watch`
  - worker runs `tsx watch`
  - web runs Vite dev server
- Bind-mount source where appropriate.
- Keep dependency containers shared with the base stack rather than creating a parallel infra topology.
- Ensure the dev override remains container-correct:
  - Vite proxy points at the `api` service, not host localhost
  - auth/web origins remain valid from the browser
- Preserve the base stack as the source of truth. The dev override should be an override, not an alternative architecture.

Dependency:

- Depends on Step 5 because the dev override should modify a known-good base stack.

### 7. Validate the production-style stack end to end before calling the work complete

Primary files:

- `docker-compose.yaml`
- optional validation scripts or Make-style helpers if introduced

Changes:

- Define and run a concrete validation sequence against real containers.
- Minimum production-style validation should prove:
  - images build successfully
  - Postgres starts and accepts connections
  - Redis starts and accepts connections
  - migrations apply successfully against the Compose DB
  - API starts and returns success from `/health`
  - worker starts without config or dependency failures
  - web serves successfully
  - a browser-visible request path from web to API works with the container-aware base URL or proxy setup
- Capture the exact commands and expected outputs in the plan or in the final implementation notes.

Exit criterion:

- Do not mark the production-style stack complete until all services build and start successfully and the basic health and routing checks pass.

### 8. Validate the Compose dev override before calling the broader plan complete

Primary files:

- `docker-compose.dev.yaml`

Changes:

- Define and run a separate validation sequence for the dev override.
- Minimum dev validation should prove:
  - the dev stack boots against the same Postgres and Redis services
  - API watch mode responds after startup
  - worker watch mode starts cleanly
  - Vite serves the app from the container
  - at least one small source edit in API or web is reflected through hot reload or automatic restart

Exit criterion:

- Do not mark the overall Compose work complete until the production-style stack works and the dev override is demonstrated to boot and hot-reload as designed.

## Concrete Implementation Biases

These should be treated as default implementation choices unless container constraints force a change:

1. Use one base `docker-compose.yaml` for the production-style local stack.
2. Use one `docker-compose.dev.yaml` override for hot-reload development.
3. Keep host-based `pnpm --filter ... dev` as an optional fast path even after Compose dev exists.
4. Prefer env overrides over Docker-only code branches.
5. Prefer multi-stage Docker builds over single-stage images with the full toolchain in runtime.
6. Treat migration success as part of stack startup readiness, not a separate manual precondition.

## Risks And Open Questions

1. **Monorepo image builds may be slow initially.** Dockerfiles must be structured carefully so dependency installation and package builds cache well.
2. **The DB migration command path is currently inconsistent.** If the documented command and package scripts disagree, that must be corrected early or Compose validation will stay fragile.
3. **Auth URL correctness is easy to get subtly wrong.** Browser-visible origins and in-container service URLs are different concerns and must stay separated.
4. **Vite-in-container ergonomics may be noisy on some host filesystems.** If file watching is unreliable, polling or platform-specific watch settings may be needed for the dev override.
5. **The worker may expose hidden startup assumptions.** The full containerized runtime will surface any remaining implicit dependency on host environment, paths, or local services.

## Validation Commands To Reach Before Completion

These are the target commands and checks the implementation should make work before the plan is considered complete:

### Production-style local stack

```bash
docker compose up --build -d
docker compose ps
docker compose logs api --tail=100
docker compose logs worker --tail=100
curl http://localhost:3000/health
```

If migrations are handled as a one-shot service or command, the validated flow must include that exact command as well.

### Compose dev override

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up --build
```

The dev validation must prove that API, worker, and web run in watch mode and that a small source edit is reflected without a full rebuild.

## Completion Rule

This plan is not complete when the files are written.

This plan is complete only when:

1. the base production-style Compose stack builds and starts successfully
2. migrations run successfully in the Compose-based flow
3. API, worker, and web all function in the running stack
4. the Compose dev override also boots and demonstrates hot reload

Until then, the documentation should be treated as an implementation plan, not a completion claim.