# Privacy Policy

*Last updated: 2026-08-19*

OpenAIdom, ("we", "our", or "us"), is an AI agent platform. This policy explains how we collect, use, and protect your data.

## Data we collect

### Account data
- Email address (required for sign-in)
- Telegram Chat ID (optional, for agent messaging)

### Trading data
- Trading activity (orders, fills, positions, P&L)
- Agent configuration (goals, styles, risk limits)
- Agent reasoning logs and decisions

### Usage data
- API access logs
- WebSocket connection metadata
- LLM usage and cost metrics

## How we use your data

- **Service operation** — To run your agents, and deliver the platform.
- **Billing** — To calculate and display your usage costs.
- **Support** — To investigate issues and respond to your inquiries.
- **Improvement** — Aggregated, anonymized data may inform product improvements. We never sell your data.

## Data storage

Your data is stored in persistent storage like:

- **Database** — Account data, trading records, agent configurations.
- **Cache** — Ephemeral session state and caching.

All data is encrypted in transit (TLS) and at rest.

## Third-party services

To operate the platform, we share necessary data with:

- **LLM providers** — Your agent's reasoning is processed by AI model providers. Only the context needed for the current tick is sent. Data derived from Google Workspace APIs is never used by these providers to train or improve their models.
- **Trading venues** — Orders are submitted to trading venues like Hyperliquid and Jupiter. Only order data is transmitted.
- **Telegram** — If you link Telegram, agent messages are delivered through the Telegram Bot API.
- **Google Workspace (Gmail)** — If you connect Gmail, we use it only to send email on your behalf through the Gmail API (`gmail.send` scope) and to read your connected account's email address (`userinfo.email` scope). We do not read, search, or store your inbox contents.

We do not share your data with third parties for their own marketing or analytics purposes.

## Google API Services User Data Policy

OpenAIdom's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Specifically:

- Raw or derived user data received from Google Workspace APIs is not used to train or improve AI/ML models, general or otherwise.
- Raw or derived user data received from Google Workspace APIs is not sold, and is not used for advertising or serving ads.
- We do not use self-hosted or offline AI models to process Google Workspace data in production — all AI providers used to process such data are third-party hosted services, selected because they do not use API-submitted data for training by default.
- Human access to Google Workspace data is limited to what is required for security, legal compliance, or with your explicit consent.

## Your rights

- **Correction** — You can update your account details and agent configurations at any time.
- **Deletion** — You can request account deletion by contacting us at support@openaidom.com. Trading records required for regulatory compliance may be retained.

## Contact

For privacy-related questions, contact us at **[support@openaidom.com](mailto:support@openaidom.com)**.
