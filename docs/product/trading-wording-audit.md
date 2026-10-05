# "Trade / trading / trader" wording audit — user-facing pages (herobids)

Scope: every occurrence of the word stem **trade / trading / trader / traderton**
(case-insensitive) in text a user actually sees in the `herobids` web app
(`apps/web`). Occurrences are resolved to the **page/route** where they render.

Excluded (not user-facing, so not keep/remove candidates):
- i18n entries whose *displayed value* has no term even though the key does
  (e.g. `capability.trading.col.when` → "When", `capability.trading.value.long` → "Long").
- Code identifiers, API routes, TS types/interfaces, test files, and code comments.

Language: **English only.** The same copy exists in Arabic (`ar`) and Hindi (`hi`)
for both the content pages and the i18n catalog. Any keep/remove decision here has
a matching translation entry to mirror.

The **Suggested update** column is grounded in the actual page copy (each cell was
read in full before a recommendation was written, not just the quoted fragment).

Guiding principle: OpenAIdom is a general AI-agent platform. The public site should
**not read as a trading product** — and it should not even carry the *residue* of
having once been one. So the goal is to erase the concept, not just swap the word:
rationales here never lean on "this isn't trading-specific", because that framing
only makes sense if trading was the default. Where a line has a genuine general
meaning, it is **Reword**ed to agent-neutral language. Where a line only exists
because of trading (positions, P&L, stop-loss, market scanning, order venues), a
clean reword is not honest — those are marked **Remove** (delete the line/section)
or **Keep** where the surface is legitimately and unavoidably trading (legal pages,
venue/data disclosures). Final decision is yours.

---

## A. Public content pages (prose — docs / help / legal / company)

| No. | Page (route) | Occurrence (sentence/text) | Suggested update |
|----:|---|---|---|
| 1 | About Us (`/company/about-us`) | "...Our agents have access to [millions of free-to-use skills](https://openaidom.com/skills)." | Keep — accurate description of core skills (also fix typo "assistantance"). |
| 2 | About Us (`/company/about-us`) | "The dashboard, tools and **trading** bots etc. exist to support the agent..." | Reword — drop the trading framing: "Everything else exists to support agents." |
| 3 | Agent Style (`/docs/agents/agent-style`) | "It determines tick cadence, tool-turn limits, token budgets, **trading** hours, and context window sizes." | Reword — "It determines tick cadence, tool-turn limits, token budgets, active hours, and context window sizes." |
| 4 | Agent Style | Heading: "**Trading** Hours" | Reword — "Active Hours". |
| 5 | Agent Style | "...the agent is permitted to **trade**. ... **Careful** restricts **trading** to 14:00–20:00 UTC..." | Reword — "...the agent is permitted to act. ... **Careful** restricts agent activity to 14:00–20:00 UTC..." |
| 6 | Agent Style | "**Weekend pause** — ...the agent suspends **trading** from Friday close to Monday open." | Reword — "**Weekend pause** — ...the agent suspends activity from Friday close to Monday open." |
| 7 | Agent Style | "**Balanced** — General-purpose **trading** agents. Runs 24/7 weekdays..." | Reword — "**Balanced** — General-purpose agents. Runs 24/7 weekdays..." |
| 8 | Billing Limits (`/docs/agents/billing-limits`) | "...whether any open **trades** remain unmanaged" | Reword — generalize to "...whether any open activity remains unmanaged" (needs confirmation of surrounding copy). |
| 9 | Billing Limits | "Your agent's **trading** logic is yours. ...how your agent thinks or **trades**..." | Reword — "Your agent's logic is yours. ...how your agent thinks or acts..." |
| 10 | Billing Limits | "...or change your **trading** state at the hard cap. It simply stops reasoning." | Reword — "...or change your agent's state at the hard cap. It simply stops reasoning." (needs confirmation of surrounding copy). |
| 11 | How costs are kept low (`/docs/agents/how-agent-costs-are-kept-low`) | "**Judge** — ...whether to act, **trade**, change course..." | Reword — "**Judge** — ...whether to act, change course..." (drop "trade"). |
| 12 | How costs are kept low | "Is it even **trading** time?" / "Is the market worth acting on?" | Remove — delete both trading-only example lines from this general cost page. |
| 13 | Agents docs index (`/docs/agents`) | "...How agent styles control LLM budget and **trading** behavior." | Reword — "...How agent styles control LLM budget and other cost-affecting behavior." |
| 14 | Agents docs index | "**Trading** \| Trading, Bot management \| Full **trading** autonomy — the agent can **trade** directly..." | Remove — delete the entire Agent Presets table (no longer used). |
| 15 | Agents docs index | "**Direct Trading** \| Trading \| The agent **trades** directly but cannot create bots." | Remove — part of the Agent Presets table being deleted. |
| 16 | Agents docs index | "**Trading Assistant** \| Trading \| Trading analysis with per-**trade** user approval..." | Remove — part of the Agent Presets table being deleted. |
| 17 | Agents docs index | "**Personal Assistant** \| ... No **trading**." | Remove — part of the Agent Presets table being deleted. |
| 18 | Agents docs index | Heading: "**Trade** Authorization" | Reword — "Authorization". |
| 19 | Agents docs index | "**Trade** Authorization (`authorizationMode`) controls how your agent's **trade** decisions reach the market. ...the **Trading** capability." | Reword — "Authorization (`authorizationMode`) controls how your agent's decisions reach the market." |
| 20 | Agents docs index | "**Direct** \| The agent executes accepted **trade** decisions immediately..." | Reword — "**Direct** \| The agent executes accepted decisions immediately..." |
| 21 | Agents docs index | "**Approval required** \| Each **trade** proposal is sent to you for approval..." | Reword — "**Approval required** \| Each proposal is sent to you for approval..." |
| 22 | Agents docs index | "The **Trading Assistant** preset defaults to Approval required. All other **trading** presets default to Direct..." | Remove/Reword — presets are gone; replace with a one-line default statement (e.g. "Authorization defaults to Direct unless you set Approval required."). |
| 23 | What are AI agents (`/docs/agents/what-are-ai-agents`) | "Connecto to external services like gmail/**trading** platforms" | Reword — restructure to a general capability list; fix typo "Connect to". See new capability copy below. |
| 24 | What are AI agents | "**Trade** crypto" | Reword — fold into the new capability list (web-browser + external-services examples) rather than leading with trading. |
| 25 | What are AI agents | "**Trade** forex (coming soon)" | Remove/Reword — replace with the general capability list below. |
| 23–25 | What are AI agents (new capability copy) | — | Reword — replace the three rows above with:<br>`AI agents on OpenAIdom can:`<br>`- Use a web browser like a human, so they can:`<br>`  - Find deals`<br>`  - Order food`<br>`  - Buy stocks`<br>`- Connect to external services like Gmail`<br>`  - send email on your behalf, or send you an email`<br>`  - send notifications via Telegram and WhatsApp (coming soon)` |
| 26 | Messaging index (`/docs/messaging`) | "...**trade** approvals (/yes, /no), and messaging." | Reword — "...approvals (/yes, /no), and messaging." Approvals are a general agent-action concept, not trading-specific. |
| 27 | Telegram slash commands (`/docs/messaging/telegram/slash-commands`) | Heading: "**Trade** Approvals" | Reword — "Approvals". The /yes /no flow applies to any action an agent proposes. |
| 28 | Telegram slash commands | "`/yes <code>` \| Approve a pending **trade** proposal..." | Reword — "Approve a pending proposal...". |
| 29 | Telegram slash commands | "`/no <code>` \| Reject a pending **trade** proposal..." | Reword — "Reject a pending proposal...". |
| 30 | Telegram slash commands | Heading: "**Trade** Approval Workflow" | Reword — "Approval Workflow". |
| 31 | Telegram slash commands | "When your agent's **Trade** Authorization is set to **Approval required**, the agent will send you a **trade** proposal before executing." | Reword — "When your agent's Authorization is set to **Approval required**, the agent will send you a proposal before executing." |
| 32 | Glossary (`/docs/reference/glossary`) | "An agent can help you **trade**, respond to emails, do your taxes..." | Keep — one example among several in a deliberately mixed list; the surrounding items already generalize it. |
| 33 | FAQs (`/help/faqs`) | Heading: "How do **trade** approvals work?" | Reword — "How do approvals work?" |
| 34 | FAQs | "If your agent's **Trade** Authorization is set to **Approval required**, the agent won't execute **trades** on its own. ...sends each **trade** proposal to you..." | Reword — "If your agent's Authorization is set to **Approval required**, the agent won't execute actions on its own. ...sends each proposal to you..." |
| 35 | FAQs | "...the agent will submit a new proposal if it still wants to **trade**." | Reword — "...the agent will submit a new proposal if it still wants to act." |
| 36 | FAQs | "See [**Trade** Authorization](...) for more on configuring authorization mode." | Reword — "See [Authorization](...) for more on configuring authorization mode." |
| 37 | FAQs | "...`/to \"DCA Bot\" pause **trading**`..." | Keep — literal command string example; "pause trading" is the actual command text. |
| 38 | FAQs | "The judge ... makes the actual **trading** decisions." | Reword — "The judge ... makes the actual decisions." |
| 39 | FAQs | "**Soft cap** — ...No **trading** behavior changes." | Reword — "**Soft cap** — ...No behavior changes." |
| 40 | FAQs | "Agents in **Filter** mode (`scanner_gated`) only receive **trading** decisions when the technical scanner wakes them..." | Reword — "...only receive decisions when the scanner wakes them...". Keep the mechanic, drop the word "trading". |
| 41 | FAQs | "Per-**trade** stop-loss and take-profit levels, plus portfolio-wide drawdown limits..." | Keep — genuinely trading-specific risk mechanics; no general equivalent. |
| 42 | Get Started (`/help/get-started`) | "...starting with crypto **trading** on Hyperliquid perpetuals, Jupiter DEX swaps, and more." | Reword — reframe as one skill among many: "...with skills like crypto trading on Hyperliquid and Jupiter, and more." Lead with the general platform, not trading. |
| 43 | Get Started | "Give it a name and a goal — describe what you want it to **trade** and how." | Reword — "Give it a name and a goal — describe what you want it to do and how." |
| 44 | Get Started | "**Trading** — Full autonomy with direct **trading** and bot management." | Remove — preset list; delete along with the Agent Presets concept (mirror of rows 14–17). |
| 45 | Get Started | "**Direct Trading** — Direct **trading** without bot management." | Remove — preset list being deleted. |
| 46 | Get Started | "**Trading Assistant** — Trading analysis with per-**trade** user approval. The agent proposes **trades**; you approve or reject each one." | Remove/Reword — presets gone; if a general equivalent is kept, phrase as "The agent proposes actions; you approve or reject each one." |
> **Legal pages (#47–#60) — migration plan, not a reword.** The trading content in
> the Privacy Policy and User Agreement is the one place "trading" was previously kept
> as unavoidable legal text. Under the "no residue of trading" direction, these pages
> should **not** stay trading-flavoured in herobids either. The plan:
>
> 1. **Move first, then strip.** The trading-specific legal clauses (data categories,
>    venue disclosures, trading-risk/liability, test-vs-live order wording) are to be
>    **relocated to traderton**, which owns the trading product and must carry this
>    legal language. Do not delete anything from herobids until the equivalent clause
>    exists in traderton's own Privacy Policy / User Agreement.
> 2. **Redraft the herobids versions.** After migration, rewrite the herobids Privacy
>    Policy and User Agreement so they are either (a) fully generic agent-platform legal
>    text, or (b) have the trading clauses removed entirely. The herobids documents must
>    read as a general AI-agent platform with no trading-specific obligations.
> 3. **Sequencing is a hard requirement** — migrate to traderton before stripping from
>    herobids, so no legally required disclosure is lost in the transition.
>
> The per-row entries below record *what* moves; the redraft of both documents is a
> deliverable to schedule when this is implemented.

| 47 | Privacy Policy (`/legal/privacy-policy`) | Heading: "**Trading** data" | Migrate → traderton, then remove/genericize here. Trading-specific data-category heading belongs in traderton's privacy policy. |
| 48 | Privacy Policy | "**Trading** activity (orders, fills, positions, P&L)" | Migrate → traderton, then remove here. Concrete order/position/P&L data types are traderton's to disclose. |
| 49 | Privacy Policy | "**Database** — Account data, **trading** records, agent configurations." | Reword here to "Account data, agent configurations" (keep the generic items); move the "trading records" item to traderton's policy. |
| 50 | Privacy Policy | "**Trading** venues — Orders are submitted to **trading** venues like Hyperliquid and Jupiter." | Migrate → traderton, then remove here. Venue (Hyperliquid/Jupiter) disclosure is specific to the trading product. |
| 51 | Privacy Policy | "...**Trading** records required for regulatory compliance may be retained." | Migrate → traderton, then remove here. Regulatory-retention clause for trading records belongs with the trading product. |
| 52 | User Agreement (`/legal/user-agreement`) | Heading: "**Trading** Agents" | Migrate → traderton, then remove here. |
| 53 | User Agreement | Heading: "**Trading** decisions" | Migrate → traderton, then remove here. |
| 54 | User Agreement | "You are solely responsible for all **trading** decisions... does not advise, recommend, or validate **trading** decisions or strategies." | Migrate → traderton, then remove here. This no-advice/liability clause is a trading-product obligation and must live where trading happens. |
| 55 | User Agreement | Heading: "**Trading** risk" | Migrate → traderton, then remove here. |
| 56 | User Agreement | "**Trading** carries a significant risk of financial loss. You should not **trade** with funds you cannot afford to lose..." | Migrate → traderton, then remove here. Financial-risk disclaimer belongs to the trading product. |
| 57 | User Agreement | Heading: "**Trading**" (section) | Migrate → traderton, then remove here (whole section moves). |
| 58 | User Agreement | "**Test** — Simulated **trading**. No real orders are placed." | Migrate → traderton, then remove here. Test/live execution-mode definitions are traderton's. |
| 59 | User Agreement | "**Live** — Real orders are placed on supported **trading** venues using real funds." | Migrate → traderton, then remove here. |
| 60 | User Agreement | "...including but not limited to **trading** losses, or data loss." | Reword here to "...including but not limited to data loss." (keep the generic liability item); move the "trading losses" limb to traderton's agreement. |

---

## B. App UI pages (resolved i18n strings — only where visible text contains the term)

| No. | Page (route) | Visible text | Suggested update |
|----:|---|---|---|
| 61 | Connections (`/connections`) | "...Blocking bots on **trading** account: {…}." (cascade-delete blocked error) | Reword — "...Blocking bots on linked account: {…}." |
| 62 | Agents / Agent detail (`/agents`, `/agents/:id`) | "**Trading**" (capability family label) | Keep — capability name. |
| 63 | Agent detail (`/agents/:id`) | "Paper **trading** works without this. Connect an external platform to enable live **trading**." | Keep. |
| 64 | Agent detail (`/agents/:id`) | "**Trading** details are unavailable until the selected connection is ready." | Keep. |
| 65 | Create Agent (`/agents/new`) | "Set up **trading** now" | Keep. |
| 66 | Create Agent (`/agents/new`) | "**Trading** guardrails" (advanced settings section title) | Keep. |
| 67 | Create Agent (`/agents/new`) | "**Trading**" (connections group label) | Keep. |
| 68 | Create/Edit Agent | "Amount this agent may **trade** with — not the full wallet balance." (Capital help) | Keep. |
| 69 | Create/Edit Agent | "**Trade** Authorization" (label) | Keep. |
| 70 | Create/Edit Agent | "**Trades** execute immediately with no human review..." (Auto mode help) | Keep. |
| 71 | Create/Edit Agent | "Each **trade** proposal is sent to you for approval before any market action..." | Keep. |
| 72 | Create/Edit Agent | "Filter **Trades**" (label) | Keep. |
| 73 | Create/Edit Agent | "Reduce cost by filtering **trade** options before AI agent sees them." | Keep. |
| 74 | Create/Edit Agent | "**Trading** Sessions" (runtime policy label) | Keep. |
| 75 | Agent detail — approvals (`/agents/:id`) | "No pending **trade** approvals." | Keep. |
| 76 | Agent detail — approvals | "**Trade** proposal rejected." | Keep. |
| 77 | Agent detail — approvals | "**Trade** executed successfully." | Keep. |
| 78 | Agent detail — approvals | "**Trade** rejected by risk checks." | Keep. |
| 79 | Agent detail (`/agents/:id`) | "Your **trading** wallet may need funding before live **trading**." (funding banner) | Keep. |
| 80 | Agent detail (`/agents/:id`) | "Give this agent a capability by adding a skill (like **Trading** or Email)..." (empty state) | Keep. |
| 81 | Agent Capability page (`/agents/:agentId/capabilities/:family`) | "Ready to **trade**" (status headline) | Keep. |
| 82 | Agent Capability page | "Not ready — no **trading** connection yet" | Keep. |
| 83 | Agent Capability page | "This agent needs a **trading** connection before it can **trade**." | Keep. |
| 84 | Agent Capability page | "Not ready — **trading** setup incomplete" | Keep. |
| 85 | Agent Capability page | "The connection is linked but its **trading** account isn't set up yet." | Keep. |
| 86 | Agent Capability page | "The connection this agent used was revoked and can no longer **trade**." | Keep. |
| 87 | Agent Capability page | "Finish **trading** setup" (action button) | Keep. |
| 88 | Agent Capability page | "Pick a connection below to let this agent **trade**." | Keep. |
| 89 | Agent Capability page | "From closed **trades**" / "From open **trades**" / "Winning **trades**" / "Open **trades**" (ledger attribute labels) | Keep. |
| 90 | Agent Capability page | "**Trades**" (feed tab label) | Keep. |
| 91 | Agent Capability page | "Total profit / loss (closed **trades** only)" (attribute) | Keep. |
| 92 | Billing / plan errors | "Live **trading** is not enabled on your current plan." | Keep. |
| 93 | Setup / provider-link (`/setup/provider-link`, Connections) | "No **trading** account found for this connection. Please complete **trading** setup first." | Keep. |
| 94 | Setup / provider-link | "Connect a **trading** exchange, email account, or custom integration..." | Keep. |
| 95 | Setup / provider-link | "**Trading**" (provider group label) | Keep. |
| 96 | Capability presentation (hybrid mode help) | "Indicators pre-filter **trade** options, LLM makes final call." | Keep. |

---

## C. SEO / page metadata

| No. | Page | Occurrence | Suggested update |
|----:|---|---|---|
| 97 | `index.html` (all pages — JSON-LD `about.description`) | "...from crypto **trading** to personal assistance." | Reword — drop the trading anchor: "...Our agents have access to millions of free-to-use skills." Positions herobids as a general skills platform for crawlers rather than a trading product. |

---

### Summary

- Total occurrences tabulated: **97** (A: 1–60, B: 61–96, C: 97).
- Direction updated: remove trading-centric wording wherever a general agent-platform
  framing works. "Trading" is one skill among many, so it should only appear where it is
  genuinely trading-specific (legal, venue, risk mechanics) or a literal command/data label.
- **Remove entirely:**
  - The **Agent Presets** table (#14–#17) and its mirror in Get Started (#44–#46) — presets are no longer used.
  - The two trading-only example lines on the cost page (#12): "Is it even trading time?" and "Is the market worth acting on?".
- **Reword to generic agent language** (`trade/trading` → `act/activity/decision/proposal/action` or removed):
  **#2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #13, #18, #19, #20, #21, #22, #23–#25, #26, #27, #28, #29, #30, #31, #33, #34, #35, #36, #38, #39, #40, #42, #43, #61**.
  "Trade Authorization" becomes **Authorization** throughout (docs, FAQs, Telegram, UI).
- **Migrate to traderton, then strip from herobids (legal, #47–#60):** the Privacy Policy
  and User Agreement trading clauses are relocated to traderton first (which owns the trading
  product and must carry the legal language), then both herobids documents are redrafted to
  be generic agent-platform legal text with the trading obligations removed. Migrate before
  deleting so no required disclosure is lost. This is a scheduled deliverable, not a wording
  swap — see the note block above #47.
- **Keep (genuinely trading-specific or literally required):** #1, #32, #37, #41, and the
  specific **trading capability UI** in Section B (strings that live under the trading
  capability itself, e.g. the capability page, approvals panel copy, funding banner).
- **Reworded SEO (#97):** JSON-LD `about.description` becomes a general "millions of
  free-to-use skills" statement — crawlers should not see herobids as a trading product.
- **Terminology:** shared/connection UI uses **"linked account"** (#61), never "venue
  account" or "trading account". Shared approval UI (e.g. #69, #71) should mirror the
  "Authorization"/"proposal" rewording applied in Section A.
- Decisions apply equally to the `ar` and `hi` translations of the same strings.
