# Browser Pool — headless Chromium service for agent web browsing.
#
# Runs ghcr.io/browserless/chromium as a standalone service.
# The image is GPL-licensed; we run it unmodified as an isolated network service.
#
# Deploy:
#   nomad job run infra/nomad/browser-pool.nomad.hcl
#
# Networking (bug 2026/11/08 001):
#   - The port is static (3100) and bound to the `private` host network, so the
#     service registers the Hetzner private address (10.0.0.0/24), not the public
#     NIC. Agent-node UFW allows 3100 only from the private subnet and the agent
#     Docker bridge; see infra/hetzner/cloud-init-nomad-client.yaml.
#   - Port 3100 is also set in infra/hetzner/cloud-init.yaml,
#     infra/hetzner/cloud-init-nomad-client.yaml and BROWSER_POOL_PORT in
#     infra/hetzner/scripts/converge-control-plane.sh. Keep them equal.
#
# Scaling:
#   - A static port allows one instance per node. Adding `count` instances needs
#     one port per instance (see the autoscale plan) before scaling out.
#   - Increase `MAX_CONCURRENT_SESSIONS` per instance (and bump memory accordingly;
#     ~1 GB per concurrent session is a reasonable starting point).

job "browser-pool" {
  type = "service"

  group "browser" {
    count = 1

    # Static port 3100: the old allocation must release the port before the new one binds it.
    # max_parallel = 1 replaces one allocation at a time. Verify with a staging redeploy
    # (ss -ltnp | grep 3100) before relying on it.
    update {
      max_parallel     = 1
      health_check     = "checks"
      min_healthy_time = "10s"
      healthy_deadline = "3m"
      progress_deadline = "5m"
      auto_revert      = true
    }

    network {
      port "http" {
        static       = 3100
        to           = 3000
        host_network = "private"
      }
    }

    task "browserless" {
      driver = "docker"

      config {
        image = "ghcr.io/browserless/chromium:latest"
        ports = ["http"]
      }

      env {
        MAX_CONCURRENT_SESSIONS = "2"
        TIMEOUT                 = "60000"
        QUEUE_LENGTH            = "10"
        DEFAULT_LAUNCH_ARGS     = "[\"--no-sandbox\",\"--disable-dev-shm-usage\"]"
      }

      resources {
        memory = 2048
        cpu    = 500
      }
    }

    service {
      # Nomad-native discovery: the worker resolves this via GET /v1/service/browser-pool,
      # and agent nodes run no Consul (the default provider "consul" makes the job unplaceable).
      provider = "nomad"
      name     = "browser-pool"
      port     = "http"

      check {
        type     = "http"
        path     = "/json/version"
        interval = "10s"
        timeout  = "3s"
      }
    }
  }
}
