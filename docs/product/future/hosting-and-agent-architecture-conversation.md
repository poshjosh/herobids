# Conversation: Agent hosting, scaling and the continuity plan

**Date:** 2026-10-30 to 2026-11-01
**Participants:**
- **User:** Chinomso Ikwuagwu (founder, herobids / traderton)
- **Assistant:** GitHub Copilot CLI assistant (AI, running inside VS Code)

**Format:** Turns are labelled by speaker. User messages are reproduced in substance. Assistant replies are condensed to their main points. Tool output, IDE selection noise and file dumps are omitted.

---

## Turn 1 - User

Read the documents in `docs/features/2026/10/30/001-agent-continuity-and-safe-capacity/`.

Are we on a wild goose chase? Can Nomad, and particularly our planned setup, support tens of thousands of users?

## Turn 1 - Assistant

**Short answer:** Not a wild goose chase to choose Nomad, but the planned setup is a safety and recovery foundation, not yet a demonstrated architecture for tens of thousands of concurrent agents.

Key points:

- Nomad is designed for large fleets. HashiCorp recommends three or five servers for production.
- User count is not the scheduler's limiting unit. Concurrent running agents, memory, CPU, browser capacity, database connections, Redis load and heartbeat traffic are.
- Illustrative memory reservations: 20,000 users with 1,000 concurrent agents at 256 MB each is roughly 250 GiB before browsers, overhead and reserve.
- The current topology has one control-plane server, `nomad_bootstrap_expect = 1`, and a single shared API/worker/Postgres/Redis stack. That is a central failure domain.
- Each agent runtime opens two Redis connections and may create its own database client. At 20,000 running agents that means roughly 40,000 Redis connections and about 4,000 heartbeat messages per second at five-second intervals.
- The base Redis configuration uses `allkeys-lru` with a 512 MB limit, which is not a durability contract for acknowledged work.
- The browser pool is a single instance with two concurrent sessions.
- The initial scaler adds at most two nodes per event with a five-minute cooldown. Sustained expansion is roughly 24 nodes per hour, which is too slow for a large cold burst.
- Recommendation: keep Nomad, keep the immediate safety work, and add a scale-validation track (workload envelope, measured density, shared-service limits, production topology, progressive load gates, burst policy).

---

## Turn 2 - User

Would moving to AWS save us the hassles? I need you to think out of the box.

## Turn 2 - Assistant

Summary:

- AWS would mainly remove some infrastructure operations, not the application problems.
- Moving existing servers to AWS mostly changes the bill. Moving to managed services and changing how agents run could change the problem.
- The out-of-the-box idea: an agent being "active" does not need to mean its container runs continuously. The agent can keep its goals, memory and pending work durably, and run only when work arrives.
- Fargate: pay per requested resource while a task runs, including idle time. Smallest listed configuration is 0.25 vCPU and 0.5 GB. It makes idle containers easier to run, not free.
- Amazon Bedrock AgentCore Runtime was identified as the most relevant managed option. Its microVM sessions default to 15 minutes idle and 8 hours maximum lifetime.
- Recommendation at that point: explore AWS seriously as a managed, event-driven platform, not a lift-and-shift, after a bounded comparison using real agent code.

---

## Turn 3 - User

Asked the assistant to proceed with the proposed plan and to avoid overengineering. The user then asked what "what we are doing next" meant, in light of the plan and the AWS discussion.

## Turn 3 - Assistant

Summary:

1. Finish the current safe-capacity milestone with evidence. Do not treat the plan's paper status as verification.
2. Start the non-invasive capacity and economics measurements alongside it.
3. Make the hosting decision through a bounded comparison: retain Nomad versus managed AWS (Fargate or AgentCore).
4. Next engineering investment: portable durable continuation (accepted inputs, committed progress, attempts and ownership, action intent and outcome).
5. Defer elaborate node-maintenance automation until the hosting choice is made.

---

## Turn 4 - User

"I want to crash the whole process. I am a one man company. I don't have the time or resources to do the whole elaboration you just meted out."

Proposed working from section 3 of the previous answer: compare Nomad versus managed AWS, starting with the AgentCore runtime documentation.

## Turn 4 - Assistant

- Acknowledged the feedback and simplified the scope.
- Reviewed AgentCore documentation: sessions, lifecycle settings, V2 snapshot startup, filesystem configurations, Instances, quotas and security practices.
- Findings:
  - Session storage exists as a preview on microVMs and survives stop/resume, but resets after a version update or 14 days without invocation. It is not a sole authoritative store.
  - Instances compute offers up to 14-day sessions on EC2 in the user's account, with persistent EBS volumes.
  - Per-session limits: 2 vCPU and 8 GB. Active sessions default to 5,000 in us-east-1 and us-west-2, 2,500 elsewhere, adjustable.
  - AWS warns that code in a microVM can reach the execution-role credentials via MMDS.
  - No definitive documentation that privileged Linux capabilities (CAP_NET_ADMIN, CAP_SYS_ADMIN) used by our sandbox script are supported.
- Compatibility gates: adapt startup from a process to an invocation/health server, verify the shell sandbox and credential exposure, and build an ARM64 image.
- Recommendation: run one narrow AgentCore trial (microVMs, V1) with one real agent covering invocation, reasoning and tool use, shell isolation, stop/resume, and a cost observation.

---

## Turn 5 - User

Asked what the sentence "My recommendation: buy the runtime operations if this trial passes. Keep the indispensable application guarantees, but stop treating a complete home-built orchestration system as the price of launching your company" means, in simple language.

## Turn 5 - Assistant

- Let AWS operate the computers; you own what agents do for users.
- The application guarantees still need your own work: accepted messages must not disappear; agents must save progress to resume; recovery must not blindly repeat actions such as orders; users must not see each other's data.
- Analogy: you do not need to build a power station to open a shop.

---

## Turn 6 - User

What if AgentCore cannot handle millions or billions of agents? "We know we will get there." Why not build the earlier idea of "event-driven, not one agent per node"?

## Turn 6 - Assistant

- Agreed event-driven execution is the stronger long-term direction, and that it is separate from the AWS/Nomad choice.
- Clarified that the current setup is one container per running agent, not one server per agent; containers share servers. The inefficiency is keeping containers alive while agents wait.
- Proposed a model: agent identity and state are stored durably (goal, permissions, conversation, progress, waiting events, schedules, unfinished actions). Work starts when events arrive, and execution is released afterwards.
- AgentCore is one possible execution supplier behind a narrow interface, not the permanent home of every agent.
- Caveats: event-driven reduces the cost of waiting, not the cost of work. Scale should be measured in events per second, execution duration and peak concurrent work, not registered agents.
- Revised recommendation: make the durable event-driven model the destination, rent execution capacity, and start with one complete path (user message wakes agent, agent works, saves progress, stops, next message resumes).

---

## Turn 7 - User

"The container only when needed thought is not ok. It takes time to spin up a container. This is not acceptable."

## Turn 7 - Assistant

- Agreed. "Event-driven" must not mean cold-start on demand.
- Target: keep execution capacity warm and hand it work when events arrive (a taxi rank, not manufacturing a taxi per ride).
- Trade-off: fast starts require paying for spare ready capacity. Bursts beyond that headroom must queue, add capacity with delay, or be covered by purchased headroom.
- Two kinds of work:
  - Trusted agent logic can run in shared warm workers, with strict per-agent state separation.
  - Arbitrary shell, installed code or browser workloads need stronger isolation, and warm environments must be clean and not reused across users without reset.
- AgentCore's snapshot startup does not prove a warm pool or the user's latency target; this must be measured.

---

## Turn 8 - User

Proposed working with the Nomad and Terraform setup and the plans in `docs/features/2026/10/30/001-agent-continuity-and-safe-capacity/` until one or two thousand agents. The company is pre-launch, with about 20 testers who responded positively. The user said the decisions were complex and that the assistant had not previously seen the container-startup lag problem. Asked what the proposed plan gives and does not give, in simple terms.

## Turn 8 - Assistant

**Yes. Staying with Nomad and Terraform for now is reasonable.** Treat 1,000–2,000 running agents as a target to verify, not something the plan guarantees.

Gives, once implemented and tested:

- Safe expansion: adds servers without replacing occupied ones; waiting agents start without manual retry; limits enforced; waiting and failure shown honestly.
- Durable continuation: restores saved progress after crash or restart; handles supported external actions without blindly repeating them.
- Controlled maintenance: brief, verified pauses for selected servers rather than losing agents' work.
- Capacity and economics: measures how many agents the infrastructure supports safely, the costs, and where delays occur.

Does not give:

- Instant startup when capacity is exhausted.
- Proven 2,000-agent capacity.
- Protection against central database, Redis or control-plane outage.
- Duplicate-free recovery for every shell or browser action.
- Guaranteed profitability or million-agent scale.
- Freedom from infrastructure operations.

Recommendation: continue the proposed direction; finish safe expansion, start basic measurements, implement continuation before moving or replacing occupied servers. Do not make AWS migration or an event-driven redesign a pre-launch requirement.

---

## Turn 9 - User

Requested that the entire conversation be saved as a markdown file in `herobids/docs/product/future/`, clearly showing that it is a conversation between two parties.

## Turn 9 - Assistant

Created this file.

---

## Notes for the reader

- Source documents referenced in the conversation are in `docs/features/2026/10/30/001-agent-continuity-and-safe-capacity/`.
- No code, infrastructure, timers or deployments were changed during this conversation. All statements about the current system are based on source reading and public AWS and HashiCorp documentation, not live environment inspection.
- Figures such as 1,000–2,000 agents, 24 nodes per hour and roughly 40,000 Redis connections are illustrative calculations from the code and configuration, not measured results.
