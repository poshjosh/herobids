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
    app = "herobids"
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
    git_repo_url          = var.git_repo_url
    git_branch            = var.git_branch
    app_domain            = var.app_domain
    deploy_ssh_private_key = var.deploy_ssh_private_key
    server_name           = var.server_name
  })

  labels = {
    app = "herobids"
  }

  # prevent_destroy protects against accidental teardown.
  # To intentionally destroy: remove this lifecycle block, terraform apply, then terraform destroy.
  # Alternatively: terraform state rm 'hcloud_server.default' then terraform destroy.
  lifecycle {
    prevent_destroy = true
  }
}


