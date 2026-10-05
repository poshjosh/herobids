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

The **Suggested update** column is a starting recommendation, framed around
OpenAIdom being a general AI-agent platform where trading is one skill among many.
`Keep` = trading-specific, legal, or capability text where the word is correct and
necessary. `Review` / `Reword` = places where the word may over-center trading on a
general surface. Final decision is yours.

---

## A. Public content pages (prose — docs / help / legal / company)

| No. | Page (route) | Occurrence (sentence/text) | Suggested update |
|----:|---|---|---|
| 1 | About Us (`/company/about-us`) | "...Our agents have access to [millions of free-to-use skills](https://openaidom.com/skills)." | Keep — accurate description of core skills (also fix typo "assistantance"). |
| 2 | About Us (`/company/about-us`) | "The dashboard, tools and **trading** bots etc. exist to support the agent..." | Keep — "trading bots" is a concrete example. |
| 3 | Agent Style (`/docs/agents/agent-style`) | "It determines tick cadence, tool-turn limits, token budgets, **trading** hours, and context window sizes." | Review — "trading hours" is trading-only; consider "active hours" for a general style doc. |
| 4 | Agent Style | Heading: "**Trading** Hours" | Review — consider "Active Hours" (style applies to all agents, not just trading). |
| 5 | Agent Style | "...the agent is permitted to **trade**. ... **Careful** restricts **trading** to 14:00–20:00 UTC..." | Review — generalize to "act"/"operate" or scope the section to trading agents. |
| 6 | Agent Style | "**Weekend pause** — ...the agent suspends **trading** from Friday close to Monday open." | Review — "suspends activity" is more general. |
| 7 | Agent Style | "**Balanced** — General-purpose **trading** agents. Runs 24/7 weekdays..." | Review — drop "trading" ("General-purpose agents"). |
| 8 | Billing Limits (`/docs/agents/billing-limits`) | "...whether any open **trades** remain unmanaged" | Keep — trading-specific consequence. |
| 9 | Billing Limits | "Your agent's **trading** logic is yours. ...how your agent thinks or **trades**..." | Review — could generalize to "your agent's logic / how it acts". |
| 10 | Billing Limits | "...or change your **trading** state at the hard cap. It simply stops reasoning." | Keep — trading-state is accurate here. |
| 11 | How costs are kept low (`/docs/agents/how-agent-costs-are-kept-low`) | "**Judge** — ...whether to act, **trade**, change course..." | Review — "act" already covers it; "trade" is one example. |
| 12 | How costs are kept low | "Is it even **trading** time?" | Review — trading-only example on a general cost page. |
| 13 | Agents docs index (`/docs/agents`) | "...How agent styles control LLM budget and **trading** behavior." | Review — "runtime behavior" is more general. |
| 14 | Agents docs index | "**Trading** \| Trading, Bot management \| Full **trading** autonomy — the agent can **trade** directly..." | Keep — preset reference table. |
| 15 | Agents docs index | "**Direct Trading** \| Trading \| The agent **trades** directly but cannot create bots." | Keep — preset reference. |
| 16 | Agents docs index | "**Trading Assistant** \| Trading \| Trading analysis with per-**trade** user approval..." | Keep — preset reference. |
| 17 | Agents docs index | "**Personal Assistant** \| ... No **trading**." | Keep — contrast is meaningful. |
| 18 | Agents docs index | Heading: "**Trade** Authorization" | Keep — feature name. |
| 19 | Agents docs index | "**Trade** Authorization (`authorizationMode`) controls how your agent's **trade** decisions reach the market. ...the **Trading** capability." | Keep — feature definition. |
| 20 | Agents docs index | "**Direct** \| The agent executes accepted **trade** decisions immediately..." | Keep. |
| 21 | Agents docs index | "**Approval required** \| Each **trade** proposal is sent to you for approval..." | Keep. |
| 22 | Agents docs index | "The **Trading Assistant** preset defaults to Approval required. All other **trading** presets default to Direct..." | Keep. |
| 23 | What are AI agents (`/docs/agents/what-are-ai-agents`) | "Connecto to external services like gmail/**trading** platforms" | Keep (fix typo "Connecto"). |
| 24 | What are AI agents | "**Trade** crypto" | Keep — capability example. |
| 25 | What are AI agents | "**Trade** forex (coming soon)" | Keep — capability example. |
| 26 | Messaging index (`/docs/messaging`) | "...**trade** approvals (/yes, /no), and messaging." | Keep. |
| 27 | Telegram slash commands (`/docs/messaging/telegram/slash-commands`) | Heading: "**Trade** Approvals" | Keep. |
| 28 | Telegram slash commands | "`/yes <code>` \| Approve a pending **trade** proposal..." | Keep. |
| 29 | Telegram slash commands | "`/no <code>` \| Reject a pending **trade** proposal..." | Keep. |
| 30 | Telegram slash commands | Heading: "**Trade** Approval Workflow" | Keep. |
| 31 | Telegram slash commands | "When your agent's **Trade** Authorization is set to **Approval required**, the agent will send you a **trade** proposal before executing." | Keep. |
| 32 | Glossary (`/docs/reference/glossary`) | "An agent can help you **trade**, respond to emails, do your taxes..." | Keep — one example in a list. |
| 33 | FAQs (`/help/faqs`) | Heading: "How do **trade** approvals work?" | Keep. |
| 34 | FAQs | "If your agent's **Trade** Authorization is set to **Approval required**, the agent won't execute **trades** on its own. ...sends each **trade** proposal to you..." | Keep. |
| 35 | FAQs | "...the agent will submit a new proposal if it still wants to **trade**." | Keep. |
| 36 | FAQs | "See [**Trade** Authorization](...) for more on configuring authorization mode." | Keep. |
| 37 | FAQs | "...`/to \"DCA Bot\" pause **trading**`..." | Keep — command example. |
| 38 | FAQs | "The judge ... makes the actual **trading** decisions." | Review — "decisions" alone may suffice on a general FAQ. |
| 39 | FAQs | "**Soft cap** — ...No **trading** behavior changes." | Review — "No behavior changes" is more general. |
| 40 | FAQs | "Agents in **Filter** mode (`scanner_gated`) only receive **trading** decisions when the technical scanner wakes them..." | Keep — scanner is trading-specific. |
| 41 | FAQs | "Per-**trade** stop-loss and take-profit levels, plus portfolio-wide drawdown limits..." | Keep — trading-specific. |
| 42 | Get Started (`/help/get-started`) | "...starting with crypto **trading** on Hyperliquid perpetuals, Jupiter DEX swaps, and more." | Keep — accurate scope statement. |
| 43 | Get Started | "Give it a name and a goal — describe what you want it to **trade** and how." | Review — assumes trading; generalize to "do" for the general onboarding step. |
| 44 | Get Started | "**Trading** — Full autonomy with direct **trading** and bot management." | Keep — preset list. |
| 45 | Get Started | "**Direct Trading** — Direct **trading** without bot management." | Keep — preset list. |
| 46 | Get Started | "**Trading Assistant** — Trading analysis with per-**trade** user approval. The agent proposes **trades**; you approve or reject each one." | Keep — preset list. |
| 47 | Privacy Policy (`/legal/privacy-policy`) | Heading: "**Trading** data" | Keep — legal accuracy. |
| 48 | Privacy Policy | "**Trading** activity (orders, fills, positions, P&L)" | Keep. |
| 49 | Privacy Policy | "**Database** — Account data, **trading** records, agent configurations." | Keep. |
| 50 | Privacy Policy | "**Trading** venues — Orders are submitted to **trading** venues like Hyperliquid and Jupiter." | Keep. |
| 51 | Privacy Policy | "...**Trading** records required for regulatory compliance may be retained." | Keep. |
| 52 | User Agreement (`/legal/user-agreement`) | Heading: "**Trading** Agents" | Keep — legal. |
| 53 | User Agreement | Heading: "**Trading** decisions" | Keep — legal. |
| 54 | User Agreement | "You are solely responsible for all **trading** decisions... does not advise, recommend, or validate **trading** decisions or strategies." | Keep — legal. |
| 55 | User Agreement | Heading: "**Trading** risk" | Keep — legal. |
| 56 | User Agreement | "**Trading** carries a significant risk of financial loss. You should not **trade** with funds you cannot afford to lose..." | Keep — legal. |
| 57 | User Agreement | Heading: "**Trading**" | Keep — legal section. |
| 58 | User Agreement | "**Test** — Simulated **trading**. No real orders are placed." | Keep. |
| 59 | User Agreement | "**Live** — Real orders are placed on supported **trading** venues using real funds." | Keep. |
| 60 | User Agreement | "...including but not limited to **trading** losses, or data loss." | Keep — legal. |

---

## B. App UI pages (resolved i18n strings — only where visible text contains the term)

| No. | Page (route) | Visible text | Suggested update |
|----:|---|---|---|
| 61 | Connections (`/connections`) | "...Blocking bots on **trading** account: {…}." (cascade-delete blocked error) | Review — "venue account" or "linked account" may read better to end users. |
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
| 97 | `index.html` (all pages — JSON-LD `about.description`) | "...from crypto **trading** to personal assistance." | Keep — accurate positioning for crawlers. |

---

### Summary

- Total occurrences tabulated: **97** (A: 1–60, B: 61–96, C: 97).
- `Review` / `Reword` candidates (general surfaces where "trading" over-centers): **#3, #4, #5, #6, #7, #9, #11, #12, #13, #38, #39, #43, #61** — mostly Agent Style, the general cost/FAQ docs, onboarding, and one UI error string.
- Everything in **legal, preset references, Telegram/approval flows, and the trading capability UI** is recommended `Keep`.
- Decisions apply equally to the `ar` and `hi` translations of the same strings.
