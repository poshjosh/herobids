terraform {
  required_version = ">= 1.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# ── SSH Key ────────────────────────────────────────────────

resource "hcloud_ssh_key" "default" {
  name       = var.server_name
  public_key = file(var.ssh_public_key_path)
}

# ── Firewall ───────────────────────────────────────────────

resource "hcloud_firewall" "default" {
  name = var.server_name

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  labels = {
    app         = "herobids"
    environment = var.environment
  }
}

# ── Server ─────────────────────────────────────────────────

resource "hcloud_server" "default" {
  name        = var.server_name
  server_type = var.server_type
  location    = var.location
  image       = var.image

  ssh_keys = [hcloud_ssh_key.default.id]

  firewall_ids = [hcloud_firewall.default.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    git_repo_url               = var.git_repo_url
    git_branch                 = var.git_branch
    app_domain                 = var.app_domain
    deploy_ssh_private_key_b64 = base64encode(var.deploy_ssh_private_key)
    server_name                = var.server_name
    environment                = var.environment
    compose_overlay            = var.environment == "staging" ? "docker-compose.staging.yaml" : "docker-compose.prod.yaml"
    env_file                   = var.environment == "staging" ? ".env.staging" : ".env.prod"
  })

  labels = {
    app         = "herobids"
    environment = var.environment
  }

  # prevent_destroy protects production against accidental teardown.
  # Staging servers can be destroyed freely for iteration.
  # To intentionally destroy a production server:
  #   temporarily set environment = "staging" and apply, then terraform destroy.
  #   Or: terraform state rm 'hcloud_server.default' then terraform destroy.
  lifecycle {
    prevent_destroy = var.environment == "production"
  }
}


