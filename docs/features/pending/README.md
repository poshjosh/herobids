The best bang-for-buck is [Skill Tool Validation]( 001-plan.md ). It has a broad system-wide payoff: it hardens both worker startup and API writes, adds a shared allowed-tool catalog, and prevents an entire class of broken or drifted skills from reaching runtime. The scope is also fairly contained compared with the bigger product rollouts.

I’d rank the main contenders like this:
- [Skill Tool Validation]( 001-plan.md ) is the strongest leverage per day because it protects a core trust boundary across the whole agent system.
- [Internationalization Rollout]( i18n-rollout-plan.md ) has the largest user-facing surface area, but the plan itself is much larger and the effort is multi-week.
- [Birdeye Provider Plan]( 001-plan.md ) is probably the quickest small win, but it’s narrower in product impact.
- [024 Backtesting Agent Tools]( 024-backtesting-agent-tools.md ) is valuable, but it depends on more infrastructure and is a bigger feature slice.
- [025 Trading Binding Native Bot Startup Follow-Through]( 025-trading-binding-native-bot-startup-follow-through.md ) is important cleanup, but it is mostly migration follow-through rather than net-new leverage.

If you want the shortest answer: pick [skill-tool-validation]( 001-plan.md ). If you want the biggest user-visible payoff regardless of effort, [i18n-rollout-plan.md]( i18n-rollout-plan.md ) is the larger play.