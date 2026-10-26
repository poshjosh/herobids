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

## Deleting an agent

Open the delete dialog on the agent. If the agent has children, you can choose one of two options:

- **Delete this agent and all of its child agents.** This removes the agent, every agent below it, and their bots.
- **Delete this agent only.** Its child agents are kept and move to the top level. The agent's own bots are removed. The children's bots are not touched.

Before you can delete, every agent affected must be stopped. The dialog lists any agents that are still running. Stop them, then try again. The dialog also shows how many agents and bots will be affected before you confirm.

If deletion fails partway, for example because the trading service is unavailable, some bots may already have been removed while the agents remain. Run the same deletion again to finish it.
