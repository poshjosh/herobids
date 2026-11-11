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

# Install the UID-based egress rules when this container has NET_ADMIN (bit 12 of
# CapEff). Without NET_ADMIN the rules cannot be installed, so sandbox-exec.sh
# refuses to run commands. This is a deliberate choice: a container that cannot
# protect its sandbox should say so rather than run unrestricted.
# The capability is read from /proc rather than an env flag, so the check matches
# what the kernel actually granted, not what the job spec asked for.
cap_eff=$(awk '/^CapEff/ {print $2}' /proc/self/status 2>/dev/null)
if [ -n "$cap_eff" ] && [ $(( 0x$cap_eff >> 12 & 1 )) -eq 1 ]; then
  /usr/local/bin/sandbox-egress.sh || {
    echo "entrypoint: sandbox egress rules failed to install; refusing to start" >&2
    exit 1
  }
fi

exec "$@"
