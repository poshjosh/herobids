# Plan C3: Capability-agnostic frontend

- **Task:** C3 — move capability-specific presentation behind capability → connection while making the frontend a generic renderer.
- **Repo:** herobids (with traderton capability-response support in C3b)
- **Status:** **REVIEW-CORRECTED; PENDING IMPLEMENTATION AUTHORIZATION** — ADR 014 ratifies the target; this plan does not authorize implementation.
- **Prereq:** ADR 014; independent review complete. C3b additionally requires C1.

## Target contract

Herobids exposes `GET /agents/:agentId/capabilities/:family/presentation` with
optional `connectionId`, `cursor`, and `limit` parameters. The API verifies
ownership and that the requested connection is actively bound to the capability.
Without `connectionId`, it resolves the default-ready connection and then the
first-ready fallback. It returns an unavailable presentation, not guessed values,
when no usable connection exists.

Capability details expose connection-scoped attributes and feeds. The response
shape is:

```ts
type CapabilityAttribute = {
  key: string;
  label: string;
  value: string;
  emphasis?: 'neutral' | 'positive' | 'negative' | 'warning';
};

type CapabilityFeedItem = {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  emphasis?: CapabilityAttribute['emphasis'];
};

type CapabilityFeed = {
  key: string;
  label: string;
  items: CapabilityFeedItem[];
  nextCursor?: string;
};

type CapabilityPresentation = {
  family: string;
  connection: { id: string; label: string; state: 'ready' | 'unavailable' } | null;
  attributes: CapabilityAttribute[];
  feeds: CapabilityFeed[];
};
```

The frontend maps `emphasis` to theme tokens. It does not send colors to, or
derive trading semantics from, a raw capability value. Capability history is a
generic feed, not an attribute table.

For `trading`, Traderton's read boundary supplies profile-backed execution mode,
account/risk display values, and decision/position/fill feed values with their
emphasis. Herobids owns capability-binding validation, connection label, and the
non-enforcing approval-mode display attribute. The web app receives only this
contract; it does not import trading formatters or calculate trading semantics.

## C3a — Visual de-specialization

May run in parallel with C1 after review. Preserve existing sources temporarily.

1. Add generic capability attribute and feed UI components.
2. Remove `executionMode`, `authorizationMode`, strategy, P&L, trade counts,
   win rates, and capability-specific metrics from the agents page, summary
   cards, and generic detail header.
3. Render the existing trading details through the trading capability and its
   connection using the generic components.
4. Keep approvals as a platform workflow, but render the proposal/result detail
   through the relevant capability context.
5. Update the affected cases in `docs/tech/user-acceptance-tests.md`, then run
  those C3a cases against the local frontend at desktop and mobile viewport
  sizes. Record date, commit, status, and evidence in that checklist.

## C3b — Profile-backed true agnosticism

Runs after C1.

1. Replace transitional detail adapters with a typed, connection-scoped
   capability presentation response from the capability service.
2. Source profile-backed execution state through the boundary; expose
  authorization state as a capability presentation attribute without assigning
  its storage to the trading profile.
3. Move histories, decisions, and trade-like records into generic capability
   feeds.
4. Delete `formatPnl`, `pnlColor`, and other frontend code that interprets
   trading values or their visual meaning.
5. Replace the C3a UAT expectations with profile-backed presentation behavior
  and run the updated cases after the cross-stack profile path is available.

## Verification

- Unit tests: generic attribute emphasis maps only to generic theme tokens;
  no trading formatter is used by generic agent components.
- UI tests: a second fixture capability renders with the same components and no
  capability-specific branching.
- Cross-stack: profile-backed attributes appear after C1; a negative or warning
  state is emphasized only from the backend hint.
- Static sweep: generic agent surfaces contain no direct trading labels,
  endpoints, or P&L formatter imports.
- UAT: the relevant rows in `docs/tech/user-acceptance-tests.md` are updated
  before each phase is run, then recorded as pass/fail/blocked with evidence.

## Risks

- A generic-looking component can still depend on trading-shaped data. C3b must
  replace, not merely wrap, the transitional adapter.
- Capability attributes need locale-aware labels eventually; C3a may retain
  current labels while C3b fixes the boundary contract.
- Approval actions must not be moved into traderton; only their capability data
  moves behind the capability presentation.
- A presentation response is unavailable rather than synthesized when its
  selected connection or Traderton read surface is unavailable.

## References

- ADR 014 / B6
- C1 trading-profile slice
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/AgentSummaryCard.tsx`
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/features/agents/AgentCapabilityPage.tsx`