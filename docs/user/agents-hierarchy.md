# Agent Hierarchy, Child Allowance and Deletion

An agent can create child agents if you allow it. This page explains how to see them, set how many an agent may create, and delete agents that have children.

## Hierarchy view

The Agents page shows your agents as a tree. Agents created by another agent are indented under their creator.

- Use the arrow on a row to expand or collapse it. Top-level agents with up to five children start expanded. Other agents start collapsed.
- Each agent with children shows how many it has used, for example "2 of 5 children used".
- When you search, matching agents show their parents so you can see where they sit in the tree.
- A child shows "Created by <name>". If its creator has been deleted, it shows "Created by a deleted agent".

## Child allowance

Each agent has a child allowance, which is the number of child agents it may create. Only you can change it. An agent cannot raise its own allowance.

- Open the agent's settings and find the child agents allowance.
- The limit can be set from 0 up to your plan's maximum, which is shown on the card.
- Lowering the limit below the current number of children keeps the existing children.
- A child starts as soon as its parent creates it, unless the parent creates it stopped. You can stop or start it from its page.

An agent may also pause or stop its direct children, and send them messages. It cannot start, resume or edit them, and it cannot read their private memory.

## Skills and connections for child agents
Two settings on an agent decide what it may give its children. Only you can change them, on the same card as the child allowance, or when you create the agent. Both start off.

- **Allow this agent to give children skills it does not have.** Off: a child can get only skills the creating agent has. On: a child can get any skill you could select yourself. This changes convenience and the creating agent's footprint, not what is reachable: an agent can already add any skill you may select to itself with its `add_skills` tool, so this setting is not a security limit.
- **Allow this agent to give children any of my connections.** Off: a child can get only connections the creating agent has. On: a child can get any of your active connections. This changes account access. A child with a trading connection can trade on that account, so turn it on only when you want that.

Things to know:

- A child starts with both settings off, whatever its creator's settings are. Each agent has its own.
- Turning a setting off affects future children only. Children that already exist keep what they were given.
- The settings do not let an agent give a child the child-agent skill, or a skill or connection you could not assign yourself.
- When a grant is refused, the agent reports it to you. Assign the skill or connection to the agent, or turn the setting on.

## Deleting an agent

Open the delete dialog on the agent. If the agent has children, you can choose one of two options:

- **Delete this agent and all of its child agents.** This removes the agent, every agent below it, and their bots.
- **Delete this agent only.** Its child agents are kept and move to the top level. The agent's own bots are removed. The children's bots are not touched.

Before you can delete, every agent affected must be stopped. The dialog lists any agents that are still running. Stop them, then try again. The dialog also shows how many agents and bots will be affected before you confirm.

If deletion fails partway, for example because the trading service is unavailable, some bots may already have been removed while the agents remain. Run the same deletion again to finish it.
