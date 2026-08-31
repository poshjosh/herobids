#!/bin/sh
# Agent container entrypoint — writes runtime config files, then execs the main process.

# Configure agent-browser CLI to use CDP if AGENT_BROWSER_CDP_URL is set.
# This avoids needing a local Chrome installation — the CLI connects to the
# shared Browserless pool over the Docker network.
if [ -n "${AGENT_BROWSER_CDP_URL:-}" ]; then
  # Write CDP config for the agent user (execute_shell runs as uid 1001).
  mkdir -p /home/agent/.agent-browser
  printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /home/agent/.agent-browser/config.json
  # The entrypoint runs as root — chown so the agent user can create sockets/PIDs.
  chown -R agent:agent /home/agent/.agent-browser
  export AGENT_BROWSER_CONFIG="/home/agent/.agent-browser/config.json"

  # Write the same config for root (execute_code runs as root, HOME=/root).
  mkdir -p /root/.agent-browser
  printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /root/.agent-browser/config.json
fi

exec "$@"
