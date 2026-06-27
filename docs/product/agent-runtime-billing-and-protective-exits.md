# Agent Runtime Billing And Protective Exits

## Problem Statement

HeroBids agent runtime costs money. We cannot allow users to continue consuming full agent runtime after they stop paying or hit a hard billing limit.

At the same time, a hard stop creates a trading-risk problem when an agent still has open positions.

Today, the runtime behavior is inconsistent with the product policy we want:

- A hard billing limit skips agent ticks instead of allowing normal scout or judge work.
- Open positions can remain live after that skip.
- Price watches and wake signals can still fire, but they do not help if the billing gate prevents the agent from acting.
- The current platform can therefore leave a user with open exposure but without active intelligence.

This is not acceptable as a product state.

## Core Constraints

The solution space is constrained by product, legal, and technical requirements.

### Product Constraints

- Full agent runtime is a paid capability.
- Unpaid users must not continue receiving normal agent reasoning, wake-driven decisioning, or ongoing runtime service.
- The platform should not allow unmanaged exposure states that are easy to create and hard to explain.

### Legal And Policy Constraints

- The platform must not submit exits the user did not explicitly configure.
- A system-owned discretionary or inferred exit is out of scope.
- Any protective action that survives billing suspension must be traceable to an explicit user instruction given before suspension.

### Technical Constraints

- Orderbook venues can support resting limit-order semantics and reduce-only behavior.
- Swap venues currently do not have resting orders in the current architecture; swaps are atomic.
- Hard billing limits currently block the agent runtime, not previously submitted venue orders.

## The Real Problem

The real problem is not just unpaid runtime.

The real problem is this:

> What states are we willing to allow when a user becomes unpaid while still carrying exposure?

Once system-owned exits are excluded, the answer becomes stricter:

- An unpaid user cannot keep full agent intelligence.
- An unpaid user can only remain exposed if that exposure is already protected by explicit, pre-armed instructions.
- If that protection does not exist, the platform must not transition the user into an unattended exposure state.

## Definitions

### Full Agent Runtime

The paid service that includes:

- scout and judge reasoning
- wake-driven analysis
- ongoing tool use
- active position management by the agent
- scheduled reminders and runtime intelligence loops

### Pre-Armed Protective Exit

An explicit user-authored protective instruction configured before billing suspension. It must define:

- the protected instrument or position
- the trigger condition
- the action on trigger, such as full close or partial reduce
- any size constraints
- whether the protection persists until canceled or expires at a defined time

### Venue-Native Protective Order

A protective order already placed on the venue while the user was in good standing. Typical examples are:

- reduce-only limit exit orders
- other venue-native resting exits, if the venue truly supports them

The important distinction is that the venue executes the previously submitted user instruction. HeroBids is not making a new decision after billing suspension.

### Protection-Ready Exposure

An open position is protection-ready only if it can survive loss of full runtime without requiring new platform discretion.

In practice, that means the position is covered by one of:

- a valid venue-native protective order already resting on the venue
- another explicit pre-armed protective mechanism that does not require fresh agent reasoning at trigger time

## Non-Solutions

### 1. Keep Full Runtime Running For Unpaid Users

This fails the core business rule. Runtime is the paid product.

### 2. System-Owned Auto-Flat On Trigger

This violates the stated legal and product constraint. If the user did not explicitly authorize that exit, the platform should not make it.

### 3. Let Hard-Limited Agents Keep Open Exposure Unmanaged

This is operationally and product-wise weak. It creates a state where:

- the user is not paying for intelligence
- the platform still carries exposure-related complexity
- no one can clearly explain what is supposed to happen next

## Solution Options

## Option A: Hard Stop Everything Immediately

When the user becomes unpaid:

- stop full runtime immediately
- do not allow any further agent work
- leave any existing venue state untouched

### Advantages

- simple billing story
- low platform cost
- easy to explain internally

### Disadvantages

- can leave users with unmanaged open positions
- unacceptable on swap venues where there is no venue-side resting protection in the current model
- likely to create support, trust, and dispute problems

### Assessment

Too blunt. Only acceptable if the platform first guarantees that every surviving position is already protection-ready.

## Option B: Grace Period With Full Runtime After Hard Limit

When the user becomes unpaid:

- keep full runtime alive for a grace period
- allow the agent to flatten or protect positions
- then stop runtime

### Advantages

- avoids immediate unmanaged exposure
- simple mental model for the user

### Disadvantages

- directly conflicts with the requirement that unpaid users should not continue using agent runtime
- invites abuse and unclear cutoff rules
- extends the most expensive part of the product to non-paying users

### Assessment

Not recommended.

## Option C: Paid Runtime Stops, But Only Protection-Ready Exposure May Survive

When the user becomes unpaid:

- stop full runtime
- allow already-submitted venue-native protective orders to remain in force
- allow open exposure to survive only if it is already protected by explicit user-authored instructions
- if exposure is not protection-ready, the platform must not allow that unattended state to exist

### Advantages

- preserves the paid boundary around agent runtime
- respects the legal rule against system-owned exits
- aligns surviving venue actions with explicit prior user consent

### Disadvantages

- requires stronger admission control before a position is opened
- creates a venue-dependent experience
- swap venues remain difficult because they currently lack resting-order fallback

### Assessment

This is the strongest base policy, but it needs supporting rules for unsupported venues.

## Option D: Venue-Aware Eligibility Rules For Unattended Exposure

Define a stricter policy by venue type.

### Orderbook Venues

Allow unattended exposure after billing suspension only if:

- the user explicitly configured protection
- the protection was translated into a venue-native resting order while the account was in good standing
- the remaining live state is reduce-only or otherwise clearly bounded by the prior user instruction

If those conditions are not met, the platform should not permit the position to remain unattended.

### Swap Venues

Because the current model has no resting orders:

- unpaid unattended exposure should not be allowed
- positions on these venues must be flattened or otherwise resolved before full suspension takes effect
- if the product cannot guarantee that outcome, it should not allow users to open such exposure without sufficient billing headroom or an explicit policy that suspension is blocked while the position remains open

### Advantages

- honest about venue differences
- legally cleaner than inventing platform-side actions later
- gives product and risk teams a concrete rule set

### Disadvantages

- more product complexity
- less uniform user experience
- forces tighter coupling between billing state and position-admission checks

### Assessment

Necessary, even if Option C is chosen as the top-level policy.

## Recommended Solution

Recommend a combined policy:

### Recommendation

Adopt Option C with Option D as an enforcement layer.

In plain terms:

1. Full agent runtime is always paid.
2. Once the user is hard-limited or unpaid, full runtime stops.
3. No system-owned exits are ever created after suspension.
4. Only explicit user-authored, pre-armed protections may survive suspension.
5. Unattended exposure is allowed only when it is protection-ready.
6. Venue capability determines whether protection-ready exposure is even possible.

## Policy Detail

### Rule 1: Paid Boundary

The following stop at hard limit:

- scout and judge loops
- wake-driven reasoning
- active runtime intelligence
- any new discretionary trade management

### Rule 2: No New Protective Action After Suspension Without Prior User Consent

After the user becomes unpaid, HeroBids must not:

- invent a stop-loss
- infer a take-profit
- submit a flat or reduce instruction that the user never explicitly armed

### Rule 3: Already-Placed Venue Orders May Continue

If the user explicitly authorized a protective venue order earlier and HeroBids already placed it, that order may remain live after suspension.

This is not post-suspension agent service. It is the continued effect of a prior user instruction.

### Rule 4: Unsupported Unattended Exposure Must Be Prevented Up Front

If a venue or position cannot survive without fresh runtime decisions, then the platform must prevent that state from existing.

Examples:

- swap exposure with no venue-native resting protection
- orderbook exposure where the user never armed a protective venue order

### Rule 5: Suspension Eligibility Depends On Open Exposure State

A user may be hard-limited from runtime immediately, but whether the account can enter a fully unattended suspended state depends on whether all open exposure is protection-ready.

If not all exposure is protection-ready, the product must do one of the following before final suspension:

- require the user to restore payment
- require the user to flatten while still in a paid state
- prevent opening that class of exposure in the first place unless protection is armed

## Product Design Implications

### 1. Pre-Arm Requirement

Users need an explicit way to configure protective exits ahead of time.

The product should treat this as first-class configuration, not as a hidden expert feature.

### 2. Admission Control

The platform should restrict opening positions that would become invalid under suspension policy.

Examples:

- do not allow new swap exposure if suspension would leave it unattended
- do not allow new orderbook exposure unless required protection is already armed, if the user is near billing exhaustion or on a plan that does not guarantee ongoing runtime

### 3. Billing-State UX

Users should see clear state labels such as:

- active
- active but protection required
- hard-limited
- suspended
- suspended with venue-native protection still live

### 4. Documentation And Auditability

Every surviving protective state should be explainable as:

- what the user authorized
- when it was armed
- whether it was placed venue-side
- why full runtime stopped

## Technical Implications

### Immediate Gap

Current hard-limit behavior skips agent ticks but does not itself resolve open risk. This gap should be closed by policy and enforcement, not by hidden system-owned exits.

### Needed Capabilities

- explicit product model for pre-armed protective exits
- exposure classification as protection-ready versus not protection-ready
- venue-aware suspension eligibility checks
- admission control before opening unsupported unattended exposure
- clear persistence of user authorization for protective instructions

### Orderbook Direction

Prefer explicit user-authored venue-native reduce-only resting exits where supported.

### Swap Direction

Treat swap exposure as incompatible with unattended unpaid suspension unless a lawful, explicit, non-discretionary protection mechanism exists in the future.

## Open Questions

1. Should the platform forbid opening swap exposure unless the user is on a plan or balance state that can support continued runtime until manual or agent-managed closure?
2. Should protection be mandatory for all orderbook positions, or only for users near billing risk?
3. What exact billing state should block new entries but still allow already-paid runtime until current positions are made suspension-safe?
4. How should the UI explain the difference between suspended runtime and still-live venue-native protective orders?

## Final Recommendation

HeroBids should adopt this principle:

> Unpaid users do not get agent runtime. Open exposure may survive only when the user explicitly armed protection that can continue without fresh platform discretion.

That leads to the following recommended policy:

1. Stop full agent runtime at hard billing limit.
2. Never submit system-owned exits the user did not explicitly configure.
3. Allow only pre-armed, explicit, protection-ready exposure to survive suspension.
4. Use venue-native protective orders as the preferred mechanism on orderbook venues.
5. Treat swap exposure as not eligible for unattended unpaid suspension in the current architecture.
6. Enforce this policy before exposure is opened, not only after billing failure happens.

This recommendation best satisfies the business requirement, the legal constraint, and the technical reality of the current platform.