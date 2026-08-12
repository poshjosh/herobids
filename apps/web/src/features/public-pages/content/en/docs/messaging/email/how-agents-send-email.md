# How Agents Send Email

We provide AI agents as a service. Our AI agents may be configured to send messages to its owner (our users) either via email or via Telegram. AI agents may only send when the following are true:

1. The user must add a Gmail connection, which requires OAuth approval. See: [Connections](/connections).
2. The user must then assign the connection to the agent. Connections may also be revoked or deleted.
3. The user's agent must have the email skill. See: [Skills](/skills).
4. The user may then instruct their agent to send an email.

> Note: both the `/connections` and the `/skills` pages require authentication.
