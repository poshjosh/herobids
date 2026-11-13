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
# Node pool (plan task 4.2/4.3):
#   - The job runs in the dedicated Nomad node pool "browser" (node_pool below), so it only
#     lands on the browser node and never shares a node with agents. The browser node is
#     Terraform-managed (hcloud_server.browser, var.browser_node_count/server_type) and not
#     autoscaled; capacity is one number.
#
# Scaling:
#   - A static port allows one instance per node. Adding `count` instances needs
#     one port per instance (see the autoscale plan) before scaling out.
#   - Increase `MAX_CONCURRENT_SESSIONS` per instance (and bump memory accordingly;
#     ~1 GB per concurrent session is a reasonable starting point), sized to the node.

job "browser-pool" {
  type = "service"

  # Pin the browser pool to its dedicated node pool (plan task 4.2/4.3). The browser
  # node's Nomad client registers node_pool = "browser"; agent jobs stay in the "default"
  # pool, so agents and the browser pool never share a node. The job sets no namespace, so
  # it stays in "default" and the agent demand reader (herobids-agents only) ignores it.
  node_pool = "browser"

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

      # Sized for a dedicated cx23 (2 vCPU / 4 GB; ~3819 MB / 4000 MHz usable), leaving
      # headroom for the OS and Nomad. Starting point ~1 GB and ~0.5 vCPU per concurrent
      # session; tune MAX_CONCURRENT_SESSIONS, QUEUE_LENGTH and resources from the Phase 4.4
      # load-test measurement before relying on them. When the browser node is switched to a
      # larger type (switch tooling), raise these together.
      env {
        MAX_CONCURRENT_SESSIONS = "2"
        TIMEOUT                 = "60000"
        QUEUE_LENGTH            = "6"
        DEFAULT_LAUNCH_ARGS     = "[\"--no-sandbox\",\"--disable-dev-shm-usage\"]"
      }

      resources {
        memory = 3000
        cpu    = 3000
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
