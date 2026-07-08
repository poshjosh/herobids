### 1. What specific problem is orchestration solving?

After feature 015 lands, you'll have two independent Hetzner servers (staging + production), each running Docker Compose. What drives the need to go beyond that? The orchestration doc mentions "8 containers per server, then add another" — but **what kind of containers** are filling up server capacity?

- Is it the **agent runtime containers** (spun up per-agent via the worker's Docker-in-Docker)?
- Is it **horizontal scaling** of the API/worker/web services themselves?
- Something else?

Answer

We are ochestrating agent containers not api/worker/web. We will eventually have hundreds of thousands to millions or billions. For a start we want hundreds or a few thousands to be supportable - very low or zero cost. We need this because we are an agent as a service platform. users will create agents, each of which is a separate container.

### 2. What's the expected scale?

The orchestration doc asks this but it's unanswered. Roughly how many concurrent containers do you expect?

- 10–50 (a few agents per server) — Swarm or even staying with Compose on a slightly larger server might suffice
- 50–200 (many agents) — Nomad starts making sense
- 200+ — warrants a more serious scheduler

Answer

200+ up to 2000+ before we change to something else e.g. kubernetes e.t.c

### 3. Has Nomad vs. Swarm already been decided?

The orchestration doc recommends Nomad. Is that the settled direction, or are we still evaluating? The choice dramatically changes the plan scope:

- **Docker Swarm**: trivial lift from current Compose setup (`docker stack deploy` works with compose files), but the doc notes it has a smaller ecosystem
- **Nomad**: single binary, lightweight, but introduces a new control plane to learn and operate
- **Stay on Compose + bigger servers**: if scale is modest, this might be the YAGNI answer

Answer

Nothing has been decided except: "very low or zero cost of orchestration"

### 4. Does orchestration apply to staging, production, or both?

After 015, staging and production are separate environments. Should orchestration be:

- **Production only** (staging stays single-server Compose for simplicity)?
- **Both** independently (each with its own scheduler)?
- **Unified** (a single cluster spanning both, which seems unlikely given isolation requirements)?

Answer

Orchestration applies to both staging and production independently

### 5. How does this interact with the existing agent runtime?

The worker already has Docker-in-Docker (`docker-proxy` service) for launching agent containers. With an orchestrator in the mix:

- Does the orchestrator schedule agent containers directly, replacing the worker's Docker-in-Docker?
- Or does the orchestrator only schedule the platform services (API, worker, web) while the worker still manages agent containers internally?
- This is a fundamental architectural decision.

Answer

I don't understand. We need to discuss this separately after you break it down in simple terms

### 6. Is auto-provisioning new servers a hard requirement for this feature?

The doc discusses two approaches for "when a server fills up, provision another":
- **Cloud autoscaling** (not available on Hetzner natively)
- **Terraform + event automation** (monitor → trigger `terraform apply`)

Is automated server provisioning in scope for feature 020, or can it be deferred to a follow-up (e.g., 021)? If it's in scope, what's the trigger mechanism — a cron job checking Nomad/Swarm node utilization, or something else?

Answer

Auto-provisioning is in scope. We need to compare multiple trigger mechanisms, then choose one.