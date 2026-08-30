# Browser Pool — headless Chromium service for agent web browsing.
#
# Runs ghcr.io/browserless/chromium as a standalone service.
# The image is GPL-licensed; we run it unmodified as an isolated network service.
#
# Deploy:
#   nomad job run infra/nomad/browser-pool.nomad.hcl
#
# Scaling:
#   - Increase `count` to add more task group instances behind the service.
#   - Increase `MAX_CONCURRENT_SESSIONS` per instance (and bump memory accordingly;
#     ~1 GB per concurrent session is a reasonable starting point).

job "browser-pool" {
  type = "service"

  group "browser" {
    count = 1

    network {
      port "http" { to = 3000 }
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
      name = "browser-pool"
      port = "http"

      check {
        type     = "http"
        path     = "/json/version"
        interval = "10s"
        timeout  = "3s"
      }
    }
  }
}
