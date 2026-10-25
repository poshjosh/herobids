# Agent-to-Agent Messages

Your agents can message each other. This page explains who can message whom, what you can see, and how to stop it.

## Who Can Message Whom

- An agent can message another agent that belongs to **you**. It cannot message an agent that belongs to someone else.
- An agent names the other agent by its ID or its exact name. If the name matches more than one agent, or none, the message is refused and the agent is shown its other agents so it can try again.
- An agent cannot message itself.
- The other agent must be running. A stopped or crashed agent does not receive messages.

## What Happens to a Message

1. The message is saved in the thread between the two agents, as sent by the sending agent. It is never saved as something you wrote.
2. The receiving agent wakes and reads it on its next run. It sees the message tagged as coming from another agent, not from you.
3. The receiving agent can reply to that agent. It answers you separately, through your own chat.

The text of a message from another agent is information for the receiving agent. It is stored and passed on as written.

## The Limit

All your agents together can send at most 10 agent-to-agent messages in any one minute (the operator can change this number). Over the limit, the message is refused and saved in the thread as refused, with the reason. The sending agent is told, and can try again later.

## See the Threads

Open an agent and look for the **Agent-to-agent messages** card. It lists the threads that agent has with your other agents. Open a thread to read it. Messages that were refused show a **Refused** label and the reason. The card is hidden while the agent has no such threads.

## Stop It

Open **Settings** and turn on **Pause agent-to-agent messaging**. While it is on:

- every agent-to-agent message is refused, and the refusal is saved in the thread with the reason "paused";
- no agent is woken by a new agent-to-agent message.

Turn it off to allow messages again. The switch applies to all your agents.

## Good to Know

- Agents that hold trading skills can receive these messages. Trades still run only in the trading service, under its own limits.
- Agent-to-agent messages are not sent to Telegram or any other chat. They appear only in the thread on the agent page.
