# Glossary

An alphabetic reference of terms used across the OpenAIdom platform.

## Actor

The author of an action, decision, message, or creation event. Valid types: `agent`, `bot`, `user`, `system`.

## Agent

An AI that works on your behalf. Agents respond to you, use tools, and help achieve your goals. An agent can help you trade, respond to emails, do your taxes, handle basic legal claims etc

## Agent Guardrail

Guardrails control agent behavior — tool allowlists, time budgets, pause state, request limits. Does not replace safety checks.

---

## Binding

A permission granted from a connection. Think of a connection as "link to service X" and a binding as "grant agent Y permission to use the link to service X."

---

## Connection

A link you've established between the platform and an external service (e.g. an exchange). Connections may reference a credential for authentication. Linking a service doesn't automatically grant permission — connections and permissions are separate.

## Credential

Your secret for authenticating with an external service — API keys, secrets, passphrases, or private keys. Encrypted at rest and reusable across connections.

---

## Tick

One iteration of your agent's thinking cycle. On each tick, the agent reads context, may use tools, and may submit decisions. Tick speed depends on your agent's style.
