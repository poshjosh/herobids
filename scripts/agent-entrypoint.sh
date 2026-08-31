#!/bin/sh
# Agent container entrypoint — writes runtime config files, then execs the main process.

# Configure agent-browser CLI to use CDP if AGENT_BROWSER_CDP_URL is set.
# This avoids needing a local Chrome installation — the CLI connects to the
# shared Browserless pool over the Docker network.
if [ -n "${AGENT_BROWSER_CDP_URL:-}" ]; then
  mkdir -p /home/agent/.agent-browser
  printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /home/agent/.agent-browser/config.json
  export AGENT_BROWSER_CONFIG="/home/agent/.agent-browser/config.json"
fi

exec "$@"
