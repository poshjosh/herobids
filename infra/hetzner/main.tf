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

# ── Firewall (Agent Nodes) ────────────────────────────────

resource "hcloud_firewall" "agent" {
  count = var.enable_nomad ? 1 : 0
  name  = "${var.server_name}-agent"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
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
    role        = "agent"
  }
}

# ── Private Network ───────────────────────────────────────

resource "hcloud_network" "private" {
  count    = var.enable_nomad ? 1 : 0
  name     = "${var.server_name}-net"
  ip_range = var.network_ip_range

  labels = {
    app         = "herobids"
    environment = var.environment
  }
}

resource "hcloud_network_subnet" "private" {
  count        = var.enable_nomad ? 1 : 0
  network_id   = hcloud_network.private[0].id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = var.subnet_ip_range

  lifecycle {
    precondition {
      # Basic CIDR validity: both must parse, and subnet prefix must be ≥ network prefix.
      # Full containment cannot be validated in pure Terraform — operators MUST verify
      # manually that the subnet address range falls within the network range.
      condition = (
        can(cidrhost(var.subnet_ip_range, 0)) &&
        can(cidrhost(var.network_ip_range, 0)) &&
        tonumber(regex("/(\\d+)$", var.subnet_ip_range)[0]) >=
        tonumber(regex("/(\\d+)$", var.network_ip_range)[0])
      )
      error_message = "subnet_ip_range prefix length must be >= network_ip_range prefix length. E.g., network=10.0.0.0/16 needs subnet=/16 through /32, not /8. Also verify manually that the subnet address (e.g. 10.0.0.0/24) falls within the network (e.g. 10.0.0.0/16)."
    }
  }
}

# ── Server ─────────────────────────────────────────────────

resource "hcloud_server" "default" {
  name        = var.server_name
  server_type = var.server_type
  location    = var.location
  image       = var.image
  backups     = var.backups

  ssh_keys = [hcloud_ssh_key.default.id]

  firewall_ids = [hcloud_firewall.default.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    git_repo_url                   = var.git_repo_url
    git_branch                     = var.git_branch
    app_domain                     = var.app_domain
    deploy_ssh_private_key_b64     = base64encode(var.deploy_ssh_private_key)
    server_name                    = var.server_name
    environment                    = var.environment
    compose_overlay                = var.environment == "staging" ? "docker-compose.staging.yaml" : "docker-compose.prod.yaml"
    env_file                       = var.environment == "staging" ? ".env.staging" : ".env.prod"
    enable_nomad                   = tostring(var.enable_nomad)
    nomad_version                  = var.nomad_version
    terraform_version              = var.terraform_version
    private_subnet                 = var.subnet_ip_range
    nomad_bootstrap_expect         = 1
    agent_node_count               = var.agent_node_count
    max_agent_nodes                = var.max_agent_nodes
    min_agent_nodes                = var.min_agent_nodes
    scale_out_cooldown_seconds     = var.scale_out_cooldown_seconds
    scale_out_memory_threshold_pct = var.scale_out_memory_threshold_pct
    scale_out_slot_threshold       = var.scale_out_slot_threshold
    scale_out_increment            = var.scale_out_increment
    agent_memory_reservation_mb    = var.agent_memory_reservation_mb
    agent_node_server_type         = var.agent_node_server_type
    location                       = var.location
    # Phase 7 — scale-in & safety net
    enable_scale_in                    = tostring(var.enable_scale_in)
    scale_in_drain_deadline_seconds    = var.scale_in_drain_deadline_seconds
    scale_in_max_nodes_per_run         = var.scale_in_max_nodes_per_run
    scale_in_time_utc                  = var.scale_in_time_utc
    placement_failure_window_seconds   = var.placement_failure_window_seconds
    placement_failure_threshold        = var.placement_failure_threshold
    placement_failure_cooldown_seconds = var.placement_failure_cooldown_seconds
    # Phase 8 — admin alerting
    alert_failure_threshold  = var.alert_failure_threshold
    alert_rate_limit_seconds = var.alert_rate_limit_seconds
    alert_send_recovery      = var.alert_send_recovery
    alert_smtp_host          = var.alert_smtp_host
    alert_smtp_port          = var.alert_smtp_port
    alert_smtp_use_tls       = var.alert_smtp_use_tls
    alert_from               = var.alert_from
    alert_to                 = var.alert_to
    alert_smtp_user          = var.alert_smtp_user
    alert_smtp_pass          = var.alert_smtp_pass
  })

  labels = {
    app         = "herobids"
    environment = var.environment
  }

  # prevent_destroy protects against accidental teardown in ALL environments.
  #
  # To destroy a STAGING server:
  #   1. Temporarily change this to `false`, then `terraform apply`.
  #   2. Run `terraform destroy`.
  #   Or: `terraform state rm 'hcloud_server.default'` then `terraform destroy`.
  #
  # To destroy a PRODUCTION server:
  #   Same procedure, plus: remove any agent nodes first.  
  lifecycle {
    prevent_destroy = true
  }
}

# ── Control-Plane Network Attachment ──────────────────────

resource "hcloud_server_network" "control_plane" {
  count      = var.enable_nomad ? 1 : 0
  server_id  = hcloud_server.default.id
  network_id = hcloud_network.private[0].id
}

# ── Agent Node Pool ───────────────────────────────────────

resource "hcloud_server" "agent" {
  count       = var.enable_nomad ? var.agent_node_count : 0
  name        = "${var.server_name}-agent-${count.index + 1}"
  server_type = var.agent_node_server_type
  location    = var.location
  image       = var.image

  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = var.enable_nomad ? [hcloud_firewall.agent[0].id] : []

  user_data = templatefile("${path.module}/cloud-init-nomad-client.yaml", {
    server_name       = "${var.server_name}-agent-${count.index + 1}"
    environment       = var.environment
    nomad_server_addr = hcloud_server_network.control_plane[0].ip
    node_pool         = var.server_name
    node_index        = count.index
    nomad_version     = var.nomad_version
    private_subnet    = var.subnet_ip_range
  })

  labels = {
    app         = "herobids"
    environment = var.environment
    role        = "agent"
    node_pool   = var.server_name
  }

  # Agent nodes are cattle — safe to destroy and recreate.
  # Only prevent_destroy in production if explicitly protecting capacity.
  lifecycle {
    prevent_destroy = false
  }
}

# ── Agent Node Network Attachment ─────────────────────────

resource "hcloud_server_network" "agent" {
  count      = var.enable_nomad ? var.agent_node_count : 0
  server_id  = hcloud_server.agent[count.index].id
  network_id = hcloud_network.private[0].id
  # Let Hetzner auto-assign private IPs from the subnet.
}


