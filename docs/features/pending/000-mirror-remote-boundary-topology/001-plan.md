# Plan — Mirror remote boundary topology in local cross-stack setup (HTTPS + distinct hostname)

Status: pending
Owner: (unassigned)
Created: 2026-09-26

## 1. Goal

Make the local herobids → traderton hop mirror the **remote** topology: herobids reaches the traderton boundary over **HTTPS** at a **distinct hostname**, exactly as it does against `https://api.staging.traderton.com` in prod. Today local uses `http://host.docker.internal:8080` (plain HTTP, host:port, shared host-gateway), which hides the very failure classes remote exposes: TLS termination, hostname/DNS resolution, and HMAC signature drift over the real wire.

**Explicit non-goal:** touching traderton's own postgres/redis/migrate networking. Those are already internal (compose service-name) in BOTH local and remote — there is nothing to mirror there. Exposing them locally would *diverge* from remote, not converge.

## 0. Convergence principle — "match herobids" is the default

This plan's underlying rule is: **whenever herobids already has a working convention for the same concern, traderton copies it rather than inventing a new one.** The driver is operational, not stylistic: herobids deploys repeatedly without friction because its path is generic and battle-tested, while each traderton divergence has produced a bug we pay for one at a time (the `/32` SSH lockout below, the duplicate `deploy.sh` naming, the bespoke CI-gate output buffering, the missing `DATABASE_URL` injection).

Divergence is allowed **only** when there is a strict, named reason that herobids' approach cannot be reused — never for speculative "hardening" or a preference for novelty. Each divergence must be recorded here with its justification, so a future reader can tell "deliberate" from "drifted."

### Concrete divergence to fix: SSH ingress

Herobids opens SSH to the world and relies on key auth:

```hcl
# herobids/infra/hetzner/main.tf
outbound_inbound_rule "ssh" { source_ips = ["0.0.0.0/0", "::/0"] }
```

Traderton instead restrict-port-22 to operator `/32` allowlist (`var.ssh_source_cidrs`, enforced by `guard-plan.py` and `tftest`). Result: every operator home-IP rotation causes a full lockout (`ssh: connect to host … port 22: Operation timed out`) — the exact failure seen this session, with current IP `147.161.230.93` not in the allowlist.

**Converge:** change `traderton/infra/hetzner/main.tf` port-22 rule to `source_ips = ["0.0.0.0/0", "::/0"]` (key auth remains the gate), drop `var.ssh_source_cidrs`, and update `guard-plan.py` / `tftest` / `README` that assert the `/32` policy. Ports 80/443 are already `0.0.0.0/0`.

**Why this is safe:** SSH is already key-authenticated (no password auth); the `/32` list is redundant network-layer hardening that covers the same threat the key already covers, at the cost of breaking automation on every IP change — precisely the trade herobids already rejected.

## 2. Background — how it works today (verified)

Two local paths exist; only one catches remote-shaped errors.

| Element | Remote (staging) | Local (xstack) | Gap |
|---|---|---|---|
| Herobids boundary URL | `https://api.staging.traderton.com` | `http://host.docker.internal:8080` | plain HTTP, no TLS |
| Hostname | `api.staging.traderton.com` (DNS → Caddy) | `host.docker.internal` (host-gateway IP) | no name resolution |
| TLS | Caddy terminates (`Caddyfile.staging`, LE cert) | none | no cert/handshake path |
| HMAC | signed over HTTPS | signed over HTTP | same bytes, but wire differs |
| Boundary → postgres/redis | compose service-name (private network) | compose service-name | **identical** (no gap) |

Verbatim from the relevant files:

- `docker/xstack.override.yml` injects `TRADERTON_BOUNDARY_URL: ${TRADERTON_BOUNDARY_URL:-http://host.docker.internal:8080}` + `extra_hosts: host.docker.internal:host-gateway` into `api`/`worker`.
- `scripts/shell/run/reset-and-run-xstack.sh` brings traderton up (`boundary` on `:8080`), waits on `http://localhost:8080/health/ready`, then brings herobids up with that override layered via `EXTRA_COMPOSE_FILES`.
- `traderton/docker-compose.yml` publishes the boundary `8080:8080` with **no** TLS.
- Remote `infra/hetzner/Caddyfile.staging` terminates TLS at `api.staging.traderton.com → boundary:8080` and hard-blocks the public apex from the execution surface (`respond @execution 404`).

The herobids remote env (`infra/hetzner/.env.environment.example`) already documents `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com`; local `.env.example` documents the `http://localhost:8080` default. HMAC creds are already shared correctly via `.env` on both sides — no change needed there.

## 3. What breaks if we do nothing else

Local continues to develop against a topology that cannot surface:
1. TLS-termination regressions (broken Caddyfile, cert config) — caught only after a remote deploy.
2. Hostname/DNS mismatches (wrong name, missing DNS) — invisible locally.
3. Any client code that assumes plaintext or a raw `host:port` and silently breaks when the URL becomes `https://…`.
4. The exact "it says ready but can't reach the DB" class of bug (e.g. the `DATABASE_URL`/`ECONNREFUSED` issue found this session) that `/health/ready` masks — a distinct-hostname + TLS path forces the same code shape as prod.

## 4. Decisions (proposed)

1. **Introduce a local HTTPS terminus in the traderton local stack.** Add a `caddy` service to `traderton/docker-compose.yml` (or a thin herobids-side overlay) that fronts the boundary, mirroring `Caddyfile.staging` (`api.<host> → boundary:8080`). The boundary stops being published on `:8080` directly; it is reachable only via the HTTPS front (parity with remote, where Caddy is the sole ingress).
2. **Use a reserved local hostname, not a made-up real domain.** `api.traderton.localhost` (RFC 6761: `*.localhost` resolves to loopback) — no `/etc/hosts` edit, no DNS, no public record. Alternative is a hosts-file entry + `mkcert`; `.localhost` avoids that entirely.
3. **Cert: `mkcert`-issued local CA cert (preferred) with Caddy `tls` pointing at it.** Trusted automatically by the local client; `curl`/Node won't need `NODE_EXTRA_CA_CERTS` if the CA is in the system store. Fallback documented: Caddy `tls internal` + trusting the internal CA in the herobids containers.
4. **herobids points at `https://api.traderton.localhost`.** `xstack.override.yml` default becomes the HTTPS URL; `reset-and-run-xstack.sh` waits on the HTTPS `/health/ready` (not `http://localhost:8080`), and the sanity assertion in Step 4 curls the HTTPS URL.
5. **Keep postgres/redis/migrate exactly as-is** (compose service-name; host-publish remap in `traderton-xstack.override.yml` is unrelated to the herobids hop and stays). No divergence there.
6. **Mirror the apex hard-block locally as a guard**, matching `Caddyfile.staging`'s `respond @execution 404` — so "public surface can't reach execution" is asserted locally too. Optional but cheap.

## 5. Phases

### Phase 0 — Confirm the trust/cert approach works on one dev machine
- Verify `mkcert` (or dockerized `smallstep`/`caddy` internal CA) can issue a cert for `api.traderton.localhost` that the herobids container runtime trusts without special env.
- Decide between `mkcert` and Caddy `tls internal` based on results; record the chosen approach in this plan's Decision 3.

### Phase 1 — Add local HTTPS terminus (traderton side)
- Add a local `Caddyfile.local` (mirror of `Caddyfile.staging` structure): `api.traderton.localhost → boundary:8080`, plus the apex `respond @execution 404` guard.
- Add a `caddy` service to `traderton/docker-compose.yml` (ports `443`/`80`, volume-mounted `Caddyfile.local` + cert, `depends_on boundary: service_healthy`).
- Stop publishing the boundary host port `8080:8080`; switch it to `expose` (parity with remote where Caddy is sole ingress). Update the `traderton-xstack.override.yml` comment/note accordingly if it referenced `:8080`.

### Phase 2 — Repoint herobids at the HTTPS terminus
- Update `docker/xstack.override.yml` default to `https://api.traderton.localhost` (drop `extra_hosts` host-gateway if no longer needed; keep if the HTTPS front still requires it — confirm in Phase 0).
- Update `scripts/shell/run/reset-and-run-xstack.sh`: wait on `https://api.traderton.localhost/health/ready`, and update the Step 4 sanity check + echo summary.
- Update `herobids/.env.example` default for `TRADERTON_BOUNDARY_URL` to the HTTPS URL (with the `http://localhost:8080` value noted as the pre-TLS legacy form).

### Phase 3 — Verify parity end-to-end
- Run `reset-and-run-xstack.sh`; assert the boundary-dependent provisioning produces trading connections via the **HTTPS** path.
- Negative test: confirm an unsigned call to `https://api.traderton.localhost/internal/v1/tools:invoke` returns `authentication.invalid_caller` (proves HMAC still enforced over TLS), and the apex `https://traderton.localhost/internal/…` returns 404.
- Run the live signed-call suite (`traderton/scripts/shell/tests/run-live-boundary.sh`) pointed at the local HTTPS URL (`BOUNDARY_BASE_URL=https://api.traderton.localhost`) to exercise the same signed set locally as against staging.

### Phase 4 — Converge traderton firewall/deploy to herobids conventions
- Change `traderton/infra/hetzner/main.tf` port-22 rule to `source_ips = ["0.0.0.0/0", "::/0"]`; remove `var.ssh_source_cidrs`, its `/32` validation, and the `environment.tfvars.example` block.
- Update `guard-plan.py` + `tftest` + `README` that assert the `/32` SSH policy.
- Add `147.161.230.93/32` (or just do the `0.0.0.0/0` change) and `plan-apply --env staging` — **requires explicit operator greenlight; not applied by this plan automatically.**
- (Already done this session) rename on-host `deploy.sh` → `deploy-on-host.sh`; keep `scripts/deploy.sh` as the single laptop entrypoint.

### Phase 5 — Docs
- Update `herobids/docs/best-practices/docker.md` (or the xstack setup notes) to describe the HTTPS local topology and why it mirrors remote.
- Note the `.env` env-var drift (`TRADERTON_BOUNDARY_URL` default) in the same change (AGENTS.md `.example` twin rule).
- Record the convergence principle + SSH divergence rationale (this Plan §0) so future readers can distinguish deliberate divergence from drift.

## 6. Out of scope

- Any change to traderton postgres/redis/migrate networking.
- Routing local dev through the *actual* staging domain (`api.staging.traderton.com`) — staging remains the live smoke target; local uses the reserved `.localhost` name.
- Production/staging Terraform or deploy-script changes (the remote side already terminates TLS correctly).
- Any SSH-firewall `plan-apply` execution — the plan records the intent; the apply is a separate, operator-gated action.