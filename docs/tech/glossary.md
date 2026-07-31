# Glossary

Alphabetic list of canonical terms used in OpenAIdom — code, configuration, documentation, and user interfaces.

When a term appears in a schema, API, UI, config file, or document, it must match the definition here. If a term needs to change, update this document first.

> 📚 For a narrative walkthrough of how these concepts relate, see [Domain Language](./domain-language.md).

---

## A

### Actor
The logical author of an action, decision, message, or creation event. Valid types: `agent`, `bot`, `user`, `system`. Every protocol message and decision record carries an actor type and ID.

### Agent
An isolated, LLM-driven reasoning runtime owned by a user. An agent reads approved context, calls approved tools through the platform broker, and submits strategic intent (decisions). It does not own execution authority — it cannot call venue APIs directly, write to the database, or access operator credentials. Agents run in isolated containers.

### Agent Guardrail
An orchestration or product-level control around the agent runtime (tool allowlists, CPU/time budgets, pause state, outbound request limits). Agent guardrails do not replace the engine risk gate.

### Agent Mode Purity
The principle that an agent's goal text and explicit creator-specified constraints are the source of trading policy. The platform must not inject hidden constraints the creator did not ask for. Operational mechanics (execution mode, slippage, retries, schema validation) are always enforced — they are infrastructure, not policy.

### Approval
A trade proposal that is waiting for user review before execution. When an agent's authorization mode is `approval_required`, each trade decision becomes an approval that the user must explicitly approve or reject. Approvals expire after a configurable time window.

### Approval Code
A short code that identifies a specific pending approval. Used with Telegram slash commands (`/yes <code>`, `/no <code>`) or the web Approvals panel.

### Authorization Mode
Controls whether an agent's trade decisions execute immediately or wait for user approval. Two modes: `direct` (immediate execution) and `approval_required` (each trade waits for user approval). Set when creating or editing a trading-capable agent.

---

## B

### Binding
A capability-specific target derived from a Connection. A binding adapts a connection into the shape required by a capability family (e.g. a trading binding is the concrete trading target an agent can be granted access to). Grants, readiness, and audit history attach to bindings.

### Blueprint
The configuration specification for a bot — which strategy, which venue account, which instrument, risk limits, and execution mode. The blueprint is the stable, versioned, user-configured part of a bot. Changing it increments `configVersion`.

### Bot
A deterministic strategy executor owned by a user. A bot applies a strategy against a venue account to produce trading decisions. It does not use an LLM. It owns execution authority within its risk configuration. Every bot has a creator (`creatorType` + `creatorId`).

### Bot Run (Bot Session)
The operational record of one start-to-stop execution of a bot. Captures start/stop time, blueprint version used, and final status. A bot run is transient; a blueprint is durable.

### BPS (Basis Point)
One-hundredth of a percentage point (0.01%). 100 BPS = 1%. Used throughout the system for slippage, fees, and thresholds (e.g. `defaultSlippageBps: 50` = 0.50% slippage).

---

## C

### Capability
A separately deployable isolated product or service domain boundary. A capability owns its own public contracts, domain-specific configuration, runtime service boundary, and persistence boundary where durable state is required. `crypto-trading` and `messaging` are product capabilities.

### Connection
A user-owned platform link to an external provider or system. Carries a user-facing label and may reference one Credential. Connections are capability-agnostic — they represent that something external has been linked, not what a specific agent is allowed to do with it.

### Credential
A user-owned secret record for authenticating with an external provider or system (API keys, secrets, passphrases, private keys). Credentials are encrypted at rest and may be reused across multiple connections.

---

## D

### dailyLossLimit
**User-configured instance setting.** Hard cap on rolling 24-hour realized loss for the agent's direct trading path. Stored as a decimal string in the agent's Postgres config. Units: USD (or account base currency). When the user does not set this, the operator fallback `dailyMaxLossPct` is applied instead.

### dailyLossLimitDefaultRatio
**Operator config setting.** Ratio of agent capital used to derive a default `dailyLossLimit` when the user has not explicitly configured one. Example: `0.05` means default loss limit = 5% of capital.

### dailyMaxLossPct
**Operator config setting.** Fallback/ceiling for rolling 24-hour realized loss, applied as a percentage of equity, when the creator did not set `dailyLossLimit`. Agent may adjust downward at runtime.

### Decision
A proposal to change exposure on one instrument, submitted through the platform message protocol. Decisions may originate from an agent, bot, user, or system. The engine is the sole authority over whether a decision becomes an order.

---

## E

### Execution Mode
How a trading decision is routed to a venue. The API accepts `live`, `paper`, and `shadow`. For simplicity, the UI shows only `live` and `test`, in which case `test` is mapped to a concrete simulation mode internally: `paper` when no venue is selected, `shadow` when a venue is selected.

- **Test** — Simulated. No real orders placed.
- **Live** — Real orders sent to the venue. Real capital at risk.

### Explicit Safety Invariant
A platform rule that may block or constrain trading because proceeding would be unsafe, unauthorized, unreconciled, or malformed. Examples: invalid schema, unauthorized instance access, unresolved state drift, hard exposure limits, venue mode mismatches.

---

## F

### Family
A capability-specific grouping of providers that share a common interaction shape or contract. Families are the middle level in the product taxonomy: `capability -> family -> provider`.

---

## G

### globalMaxDrawdownPct
**Operator config setting.** Global maximum drawdown as a percentage across all trading. Applies to non-agent trading flows. Default: 20%.

---

## L

### Live
See [Execution Mode](#execution-mode).

---

## M

### maxDrawdown
**Operator config setting.** Absolute ceiling on equity drawdown from session peak, in USD. Default is effectively unlimited (1,000,000,000). This is the operator ceiling for non-agent trading flows. Agents use `maxDrawdownPct` for drawdown enforcement.

### maxDrawdownPct
**User-configured instance setting.** Hard cap on peak-to-current equity drawdown for the agent's direct trading path. Stored as a numeric percentage of peak equity. When the user does not set this, the operator fallback in `config/default.yaml` is applied instead.

### maxOpenPositions
**Operator config / agent-adjustable setting.** Maximum number of concurrent non-flat (open) positions. Agents may adjust downward at runtime. Default: 10.

### maxPositionSizePct
**Operator config / agent-adjustable setting.** Maximum position notional as a percentage of capital. 100 = full capital. Agents may adjust downward at runtime.

---

## P

### Paper
Legacy execution mode. See [Execution Mode](#execution-mode).

### Platform Safety Alert
A system-authored notification delivered to a user for a critical trust or safety event. Non-configurable; always delivered regardless of agent or user preferences. Examples: runtime crash, agent paused by guardrail, critical reconciliation failure.

### Provider
The concrete integration behind a capability family. Examples include `gmail`, `telegram`, `hyperliquid`, and `bybit`.

---

## R

### Role
A user-facing archetype composed from one or more skills. Examples include `personal-assistant`, `researcher`, or `trader`. A role is not a capability.

### Reconciliation
The process of comparing the platform's internal state (positions, balances) against the venue's actual state. Drift beyond configured thresholds may trigger alerts or block trading. Runs on a configurable interval (`reconciliation.intervalMs`).

---

## S

### Shadow
Legacy execution mode. See [Execution Mode](#execution-mode).

### Skill
A reusable expertise package for an actor. A skill bundles instructions, approved tool access, and behavior guidance, and may depend on one or more capabilities.

### Skill Preset
A current implementation term for a bundled role or skill selection for an agent. Determines which skills, tools, and capability access patterns are available. Chosen at agent creation. Examples: `trading`, `personal-assistant`, `custom`.

### Slippage
The difference between the expected price of a trade and the price at which it actually executes. Configured in BPS (basis points). Test mode simulates realistic slippage via its concrete paper or shadow execution path.

### stopLossCooldownMs
**Operator config / agent-adjustable setting.** Cooldown period (in milliseconds) after a stop-loss exit before the agent may re-enter a position. Default: 300,000 ms (5 minutes).

### stopLossMaxUnrealizedLossPct
**Operator config setting.** Maximum unrealized loss per position as a percentage of equity before a forced exit is triggered. Default: 10%.

### Strategic Intent
The initiator's proposed target-state outcome. In trading terms, this is the desired final exposure, not a venue-specific order instruction. The engine converts strategic intent into an executable plan.

### Strategy Preset
A bundled configuration profile for a bot blueprint. Selects default strategy parameters, risk defaults, and execution defaults. Chosen at blueprint creation. Examples: `momentum`, `dca`, `range`. Strategy presets belong on bots; Skill Presets belong on agents.

---

## T

### Test
User-facing execution mode. See [Execution Mode](#execution-mode).

### targetSize
The desired final absolute position size for an instrument after the engine applies planning against current state. It is the desired end-state exposure, not the size of the next individual order.

### Tick
One iteration of the agent reasoning loop. On each tick, the agent reads context, may call tools, and may submit decisions. Tick interval is configurable via `llm.tickIntervalMs`.

### Trading Instance
The internal authoritative runtime for one configured bot session. Owns planning, risk enforcement, execution, reconciliation, journaling, and durable state writes. It is the boundary that separates reasoning from execution. In user-facing language, users see "bots" — the trading instance is the engine concept behind a bot.

---

## V

### Venue Account
A user-owned connection to an external trading venue (e.g. a Hyperliquid API key, a Solana wallet address). A bot blueprint references one venue account. Users provide venue account credentials; the platform determines venue type, available instruments, and supported execution modes automatically.
