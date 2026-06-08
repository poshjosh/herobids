# UI Simplification Q and A

## Prompt 1

We want a UI for creating agents that does not include much trading jargon, that makes it simple for the masses/layman to create agents to trade or do other things.

What do you think?

## Response 1

Yes. For the new repo, I would design the creator around tasks and outcomes, not around trading terminology.

A good flow is:

1. Goal first  
Start with a single question: “What should this agent do?”  
Use large cards such as:
- Trade for me
- Watch and alert me
- Research and summarize
- Automate a workflow
- Monitor something continuously
- Custom

2. Behavior next  
After the goal, ask how the agent should operate:
- Autonomous or approval required
- Fast but cautious or thorough and patient
- Daily budget
- Max tool usage
- When it should stop or ask for help

3. Capabilities next  
Let the user toggle what the agent can use:
- Web browsing
- File access
- APIs
- Messaging
- Wallet or payments
- Code tools
- Data analysis

4. Setup last  
Keep the final screen simple:
- Agent name
- Short description
- Schedule or always-on
- Notifications
- Create button

For labels, I would avoid “strategy,” “preset,” “execution,” and “decision mode” on the main path. Instead use language like:
- Goal
- Style
- Tools
- Limits
- Schedule
- Review
- Create agent

If you want trading support, keep it as one goal among many, not the organizing concept. That way a layperson can create an agent without needing to understand market structure first, while advanced users can still open an “Advanced” section for trading-specific controls.

If you want, I can turn this into a concrete screen-by-screen wizard with exact copy for each step.