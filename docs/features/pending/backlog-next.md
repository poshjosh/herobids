# Pending Feature Backlog

> **Status semantics** — statuses in this backlog are **cumulative repo-state markers**, not branch-local completion flags. `DONE` means the feature is present in the current repository tree (HEAD). `IN_REVIEW` means a code review has been requested and the implementation is under review. `IN_PROGRESS` means active work is underway. Items without a status label are not yet started.

1. DONE [Skill Tool Validation](skill-tool-validation/001-plan.md) - establish the shared tool-name trust boundary before any skill sync or startup wiring depends on it.
2. DONE [System Skill Startup Sync](system-skill-startup-sync/001-plan.md) - keep the database copy of system skills aligned with code once the tool contract is trustworthy.
3. DONE [Bug: Mismatch Between Agent And Runtime State](bug-mismatch-between-agent-and-runtime-state/001-plan.md) - fix terminal-state semantics before layering more deployment and lifecycle behavior on top.
4. DONE [Graceful Agent Deployment - Zero/Low Downtime](graceful-agent-deployment/000-graceful-agent-deployment.md) - add clean handoff and shutdown behavior after lifecycle state is consistent.
5. IN_PROGRESS [025 - Trading Binding Native Bot Startup Follow-Through](025-trading-binding-native-bot-startup-follow-through.md) - finish the binding-first startup migration once the worker lifecycle path is stable.
6. IN_REVIEW [Agent Runtime Loop Controls](agent-runtime-loop-controls/001-plan.md) - make the core agent runtime tuning knobs configurable.
7. IN_REVIEW [Agent Wake Semantics Ideal-State Plan](agent-wake-semantics-2/001-ideal-state-plan.md) - move wake delivery toward the typed, capability-aware contract.
8. IN_REVIEW [Provider Registry For Credentials And Connections](provider-registry-credentials-and-connections/REVISED.md) - establish the backend-owned provider contract that the UI can render from.
9. IN_REVIEW [Agent Risk Configuration UI](agent-risk-config-ui/001-plan.md) - expose user-visible risk controls once the surrounding contract surfaces are stable.
10. IN_REVIEW [Payment Provider Selection and Usage Dashboard](payment-provider-selection-and-usage-dashboard/001-plan.md) - separate billing-provider selection from dashboard visibility and runtime accounting.
11. IN_REVIEW [Telegram Reply Threading](telegram-reply-threading/001-plan.md) - implement the reply-based Telegram routing foundation first.
12. IN_REVIEW [Telegram Slash Commands](telegram-slash-commands/001-plan.md) - build the explicit Telegram command routing on top of the shared webhook path.
13. [024 - Backtesting Agent Tools](024-backtesting-agent-tools.md) - add historical strategy evaluation before more complex live trading polish.
14. [003 - Birdeye Provider](003-birdeye-provider/001-plan.md) - add the Solana market-data provider once the core agent surface is settled.
15. [Admin Perp Venue Observability Panel](admin-perp-venue-observability/001-plan.md) - add the operator health view after the underlying market-data surfaces are already in place.