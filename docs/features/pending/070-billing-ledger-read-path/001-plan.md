# Billing Ledger Read Path

**Status:** Draft  
**Created:** 2026-07-07

---

## Problem

`billing_ledger_entries` is a complete double-entry financial ledger. Every credit and debit is written there:

| Event | Entry type | Direction |
|-------|-----------|-----------|
| Billing period opens | `included_credit` | credit |
| User buys a top-up | `top_up_credit` | credit |
| Agent uses LLM tokens / runtime | `usage_charge` | debit |

But there is no read path. The existing `GET /billing/usage-events` endpoint only surfaces consumption telemetry (tokens, runtime ms). Credit events — plan grants and top-ups — are invisible in the UI. A user who buys a top-up has no record of it on the billing page.

---

## Goal

Add a paginated, filterable "Billing Ledger" view to the billing page that shows every financial movement (credit and debit) in chronological order, like a bank statement.

`billing_usage_events` stays as-is for consumption-detail drill-down. The new ledger view is a separate financial record.

---

## Scope

### In scope

- Repository: `listLedgerEntries(accountId, filters)` method
- API: `GET /billing/ledger-entries` endpoint
- API client: `BillingLedgerEntry` interface and `billing.ledgerEntries()` method
- Frontend: "Billing Ledger" card in `BillingPage.tsx`

### Out of scope

- New schema changes — `billing_ledger_entries` is already complete
- Write path changes — all three write paths already exist
- `manual_adjustment`, `reversal`, `reservation` entry types — not yet written anywhere; the UI should display them if they appear but the backend does not need to produce them for this feature
- Running balance column — simple per-row display first; running balance can be a follow-up

---

## Implementation

### Phase 1 — Repository

**File:** `packages/db/src/usage-billing-repository.ts`

Add interface and method:

```ts
export interface LedgerEntryFilters {
  limit?: number;
  offset?: number;
  entryType?: string;
  direction?: 'credit' | 'debit';
  periodId?: string;
  from?: Date;
  to?: Date;
}

async listLedgerEntries(
  accountId: string,
  filters: LedgerEntryFilters = {},
): Promise<{ rows: ...; total: number; limit: number; offset: number }>
```

Query rules:
- Filter on `billingLedgerEntries.accountId = accountId`
- Optional filters: `entryType`, `direction`, `periodId`, date range on `createdAt`
- Order by `createdAt DESC`
- Clamp `limit` to max 200, default 50
- Include a `count(*)` for pagination

No joins needed — all display-relevant fields are on the ledger row itself (`entryType`, `direction`, `amountMicrousd`, `currency`, `sourceType`, `sourceId`, `description`, `createdAt`).

---

### Phase 2 — API endpoint

**File:** `apps/api/src/routes/billing.ts`

Add route after the existing `GET /billing/usage-events` handler:

```
GET /billing/ledger-entries
```

Query params:

| Param | Type | Notes |
|-------|------|-------|
| `limit` | integer | clamped to 200, default 50 |
| `offset` | integer | default 0 |
| `entryType` | string | `included_credit \| top_up_credit \| usage_charge \| manual_adjustment \| reversal \| reservation \| reservation_release \| invoice_settlement` |
| `direction` | string | `credit \| debit` |
| `periodId` | string | filter to entries within a period's date range |
| `from` | ISO date string | filter on `createdAt` |
| `to` | ISO date string | filter on `createdAt` |

Response shape:

```json
{
  "records": [
    {
      "id": "led_topup_creem:evt_abc",
      "entryType": "top_up_credit",
      "direction": "credit",
      "amountMicrousd": 5000000,
      "currency": "USD",
      "sourceType": "top_up_checkout",
      "sourceId": "creem:evt_abc",
      "description": "Credit top-up (top_up_starter_500)",
      "createdAt": "2026-07-05T14:22:00.000Z"
    },
    {
      "id": "led_evt_xyz",
      "entryType": "usage_charge",
      "direction": "debit",
      "amountMicrousd": 14000,
      "currency": "USD",
      "sourceType": "usage_event",
      "sourceId": "evt_xyz",
      "description": "llm.input_tokens × 4200",
      "createdAt": "2026-07-05T14:18:00.000Z"
    }
  ],
  "total": 47,
  "limit": 50,
  "offset": 0
}
```

Security: same auth pattern as all other billing routes — `usageBillingRepo.getAccountByUserId(request.userId)` scopes the query to the authenticated user's account. Do not accept `accountId` from the request.

Validation:
- Return `400` if `direction` is provided but is not `credit` or `debit`
- Return `400` if `from` or `to` are unparseable dates
- If `periodId` is provided, verify it belongs to the user's account (use the existing `billingPeriods` scoping pattern from `listUsageEvents`)

---

### Phase 3 — API client

**File:** `apps/web/src/lib/api-client.ts`

Add type and method to the `billing` client object:

```ts
export interface BillingLedgerEntry {
  id: string;
  entryType: string;
  direction: 'credit' | 'debit';
  amountMicrousd: number;
  currency: string;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  createdAt: string;
}

export interface LedgerEntriesFilters {
  limit?: number;
  offset?: number;
  entryType?: string;
  direction?: 'credit' | 'debit';
  periodId?: string;
  from?: string;
  to?: string;
}

export interface LedgerEntriesResponse {
  records: BillingLedgerEntry[];
  total: number;
  limit: number;
  offset: number;
}
```

Add to the `billing` object:

```ts
ledgerEntries: (filters: LedgerEntriesFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.offset != null) params.set('offset', String(filters.offset));
  if (filters.entryType) params.set('entryType', filters.entryType);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.periodId) params.set('periodId', filters.periodId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return request<LedgerEntriesResponse>(`/billing/ledger-entries${qs ? `?${qs}` : ''}`);
},
```

---

### Phase 4 — Frontend

**File:** `apps/web/src/features/billing/BillingPage.tsx`

#### State additions

```ts
const [ledgerOffset, setLedgerOffset] = useState(0);
const [ledgerDirectionFilter, setLedgerDirectionFilter] = useState('');
const LEDGER_PAGE_SIZE = 50;
```

#### Query addition

```ts
const ledgerQuery = useQuery({
  queryKey: ['billing', 'ledger-entries', ledgerOffset, usageFilters.periodId, ledgerDirectionFilter],
  queryFn: () => billing.ledgerEntries({
    limit: LEDGER_PAGE_SIZE,
    offset: ledgerOffset,
    periodId: usageFilters.periodId || undefined,
    direction: (ledgerDirectionFilter as 'credit' | 'debit') || undefined,
  }),
});
```

The ledger shares the existing `periodId` filter from the usage filters section — no new filter inputs needed for v1. A single `direction` filter (All / Credits / Debits) is the only addition.

#### New card — position

Insert the new "Billing Ledger" card **above** the existing "Usage Events" card, so financial movements appear before consumption detail.

#### UI structure

```
BILLING LEDGER
─────────────────────────────────────────────────
Direction filter: [ All ▼ ] [ Credits ] [ Debits ]
─────────────────────────────────────────────────
DATE         TYPE               DIRECTION  AMOUNT
Jul 5, 14:22 Credit top-up      + CREDIT   $5.0000
Jul 5, 14:18 Usage charge       - DEBIT    $0.0140
Jul 1, 00:00 Included credits   + CREDIT   $50.0000
─────────────────────────────────────────────────
                               [ Prev ] [ Next ]
```

Column widths:
- `Date` — `whiteSpace: 'nowrap'`
- `Type` — human label for `entryType` (see label map below)
- `Direction` — colour-coded badge: green `+ CREDIT`, red `- DEBIT`
- `Amount` — right-aligned, formatted via existing `formatMicrousd()`
- `Description` — optional, show as muted secondary text below type if present

Entry type human labels:

| entryType | Display |
|-----------|---------|
| `included_credit` | Included credits |
| `top_up_credit` | Credit top-up |
| `usage_charge` | Usage charge |
| `manual_adjustment` | Manual adjustment |
| `reversal` | Reversal |
| `reservation` | Reservation |
| `reservation_release` | Reservation release |
| `invoice_settlement` | Invoice settlement |

Empty state: "No billing ledger entries recorded yet."

No-account state: show the same muted-text empty state — same pattern as usage events.

---

## Testing

No new database schema, so no migration test is needed.

Verify manually (or via integration test):

1. After an agent session, `GET /billing/ledger-entries` returns `usage_charge` debit entries.
2. After a billing period opens, the endpoint returns the `included_credit` entry.
3. After a top-up webhook fires (or a test webhook replay), the endpoint returns the `top_up_credit` credit entry.
4. Filtering by `direction=credit` returns only credit entries.
5. Filtering by `periodId` scopes results to that period's date range.
6. The frontend "Billing Ledger" card renders all three entry types with correct colour coding.

---

## File Checklist

| File | Change |
|------|--------|
| `packages/db/src/usage-billing-repository.ts` | Add `LedgerEntryFilters` interface and `listLedgerEntries()` method |
| `apps/api/src/routes/billing.ts` | Add `GET /billing/ledger-entries` route handler |
| `apps/web/src/lib/api-client.ts` | Add `BillingLedgerEntry`, `LedgerEntriesFilters`, `LedgerEntriesResponse` interfaces; add `billing.ledgerEntries()` method |
| `apps/web/src/features/billing/BillingPage.tsx` | Add ledger state, query, and "Billing Ledger" card above the "Usage Events" card |
