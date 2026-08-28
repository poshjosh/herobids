# ── Environment ────────────────────────────────────────────

variable "environment" {
  type        = string
  description = "Deployment environment: staging or production"
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

# ── Provider ───────────────────────────────────────────────

variable "hcloud_token" {
  type        = string
  description = "Hetzner Cloud API token"
  sensitive   = true
  nullable    = false

  validation {
    condition     = length(var.hcloud_token) > 0
    error_message = "hcloud_token must not be empty."
  }
}

# ── Server ─────────────────────────────────────────────────

variable "server_name" {
  type        = string
  description = "Server hostname. Convention: herobids (production), herobids-staging (staging)."
  default     = "herobids"
}

variable "server_type" {
  type        = string
  description = "Hetzner instance type"
  default     = "cx23"

  validation {
    condition     = can(regex("^(cx|ccx|cpx|CAX)\\d+$", var.server_type))
    error_message = "server_type must be a valid Hetzner instance type (e.g., cpx22, cx32, ccx53)."
  }
}

variable "backups" {
  type        = bool
  description = "Enable Hetzner automated backups (€/month per server)"
  default     = false
}

variable "location" {
  type        = string
  description = "Hetzner datacenter location"
  default     = "fsn1"

  validation {
    condition     = contains(["fsn1", "nbg1", "hel1", "ash", "hil"], var.location)
    error_message = "location must be a valid Hetzner datacenter (fsn1, nbg1, hel1, ash, hil)."
  }
}

variable "image" {
  type        = string
  description = "OS image name"
  default     = "ubuntu-24.04"
}

# ── SSH ────────────────────────────────────────────────────

variable "ssh_public_key_path" {
  type        = string
  description = "Path to SSH public key file"
  nullable    = false
}

variable "deploy_ssh_private_key" {
  type        = string
  description = "Private SSH key content for deploy key access to the git repo"
  sensitive   = true
  nullable    = false
}

# ── Deployment ─────────────────────────────────────────────

variable "git_repo_url" {
  type        = string
  description = "Herobids repo URL (private, with deploy key access)"
  nullable    = false
}

variable "git_branch" {
  type        = string
  description = "Git branch to deploy"
  default     = "main"
}

variable "app_domain" {
  type        = string
  description = "Application domain name. Convention: openaidom.com (production), staging.openaidom.com (staging)."
  default     = "openaidom.com"
}

# ── Nomad Orchestration ───────────────────────────────────

variable "enable_nomad" {
  type        = bool
  description = "Feature flag: provision Nomad cluster, private network, and agent nodes. Disable for environments that only need the single-server control plane."
  default     = true
}

variable "nomad_version" {
  type        = string
  description = "Nomad version to install on servers and agent nodes. Do NOT include the Debian package revision suffix (e.g., use '1.9.7' not '1.9.7-1')."
  default     = "1.9.7"
}

variable "terraform_version" {
  type        = string
  description = "Terraform version to install on the control-plane server for autoscale operations. Do NOT include the Debian package revision suffix (e.g., use '1.11.0' not '1.11.0-1')."
  default     = "1.11.0"
}

# ── Private Network ───────────────────────────────────────

variable "network_zone" {
  type        = string
  description = "Hetzner Cloud network zone for the private network (eu-central)."
  default     = "eu-central"
}

variable "network_ip_range" {
  type        = string
  description = "CIDR range for the environment's private network. Must not overlap with other environments in the same Hetzner project."
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.network_ip_range, 0))
    error_message = "network_ip_range must be a valid CIDR notation (e.g., 10.0.0.0/16)."
  }
}

variable "subnet_ip_range" {
  type        = string
  description = "CIDR range for the private network subnet within network_ip_range."
  default     = "10.0.0.0/24"

  validation {
    condition     = can(cidrhost(var.subnet_ip_range, 0))
    error_message = "subnet_ip_range must be a valid CIDR notation (e.g., 10.0.0.0/24)."
  }

  # ⚠️  MANUAL CHECK REQUIRED: Terraform cannot fully validate that subnet_ip_range
  #     is within network_ip_range. The hcloud_network_subnet precondition catches
  #     prefix-length mismatches, but an operator MUST verify that the subnet
  #     address range (e.g. 10.0.0.0/24) falls within the network range (e.g. 10.0.0.0/16).
  #     A mismatch (subnet 10.1.0.0/24 inside network 10.0.0.0/16) will fail at apply time.
}

# ── Agent Node Pool ───────────────────────────────────────

variable "agent_node_count" {
  type        = number
  description = "Number of Nomad client (agent) nodes to provision. The autoscaler (Phase 6) adjusts this count at runtime."
  default     = 0

  validation {
    condition     = var.agent_node_count >= 0
    error_message = "agent_node_count must be >= 0."
  }
}

variable "min_agent_nodes" {
  type        = number
  description = "Minimum number of agent nodes (scale-in floor). Enforced by the nightly scale-in routine."
  default     = 0

  validation {
    condition     = var.min_agent_nodes >= 0
    error_message = "min_agent_nodes must be >= 0."
  }
}

variable "max_agent_nodes" {
  type        = number
  description = "Maximum number of agent nodes (scale-out ceiling). Enforced by the autoscale loop."
  default     = 5

  validation {
    condition     = var.max_agent_nodes >= 0
    error_message = "max_agent_nodes must be >= 0."
  }
}

variable "agent_node_server_type" {
  type        = string
  description = "Hetzner instance type for agent (Nomad client) nodes."
  default     = "cx23"

  validation {
    condition     = can(regex("^(cx|ccx|cpx|CAX)\\d+$", var.agent_node_server_type))
    error_message = "agent_node_server_type must be a valid Hetzner instance type (e.g., cpx21, cx32, ccx53)."
  }
}

# ── Autoscale Configuration ───────────────────────────────

variable "scale_out_cooldown_seconds" {
  type        = number
  description = "Minimum seconds between consecutive scale-out operations. Prevents flapping during transient capacity dips."
  default     = 300

  validation {
    condition     = var.scale_out_cooldown_seconds >= 0
    error_message = "scale_out_cooldown_seconds must be >= 0."
  }
}

variable "scale_out_memory_threshold_pct" {
  type        = number
  description = "Scale out when free allocatable memory across the Nomad cluster drops below this percentage of total memory."
  default     = 20

  validation {
    condition     = var.scale_out_memory_threshold_pct >= 1 && var.scale_out_memory_threshold_pct <= 100
    error_message = "scale_out_memory_threshold_pct must be between 1 and 100."
  }
}

variable "scale_out_slot_threshold" {
  type        = number
  description = "Scale out when free agent slots (free memory / agent memory reservation) drops below this count."
  default     = 3

  validation {
    condition     = var.scale_out_slot_threshold >= 0
    error_message = "scale_out_slot_threshold must be >= 0."
  }
}

variable "scale_out_increment" {
  type        = number
  description = "Number of agent nodes to add per scale-out event. Keep at 1 for gradual scaling; increase for burst capacity provisioning."
  default     = 1

  validation {
    condition     = var.scale_out_increment >= 1
    error_message = "scale_out_increment must be >= 1."
  }
}

variable "agent_memory_reservation_mb" {
  type        = number
  description = "Scheduling memory reservation per agent slot (MB). Used by the autoscaler to compute free slot counts from available cluster memory."
  default     = 256

  validation {
    condition     = var.agent_memory_reservation_mb >= 64
    error_message = "agent_memory_reservation_mb must be >= 64."
  }
}

# ── Scale-In Configuration (Phase 7) ──────────────────────

variable "enable_scale_in" {
  type        = bool
  description = "Feature flag: enable nightly scale-in (Phase 7). When true, the nomad-scale-in systemd timer drains idle agent nodes at the configured time. Set false to disable conservative scale-down."
  default     = false
}

variable "scale_in_drain_deadline_seconds" {
  type        = number
  description = "Maximum seconds to wait for a draining node to empty its allocations before terraform destroy. Idle nodes drain immediately; this deadline covers nodes with residual system or terminal allocations."
  default     = 600

  validation {
    condition     = var.scale_in_drain_deadline_seconds >= 60
    error_message = "scale_in_drain_deadline_seconds must be >= 60."
  }
}

variable "scale_in_max_nodes_per_run" {
  type        = number
  description = "Maximum number of agent nodes to drain and remove per nightly scale-in run. Keeps scale-in gradual; set higher for more aggressive cost reduction."
  default     = 1

  validation {
    condition     = var.scale_in_max_nodes_per_run >= 1
    error_message = "scale_in_max_nodes_per_run must be >= 1."
  }
}

variable "scale_in_time_utc" {
  type        = string
  description = "UTC time for nightly scale-in, as a crontab-style hour field (0-23). The systemd timer fires daily at this hour. Default 3 = 3 AM UTC."
  default     = "3"

  validation {
    condition     = can(regex("^\\d{1,2}$", var.scale_in_time_utc)) && tonumber(var.scale_in_time_utc) >= 0 && tonumber(var.scale_in_time_utc) <= 23
    error_message = "scale_in_time_utc must be a number between 0 and 23 (UTC hour)."
  }
}

# ── Placement-Failure Safety Net (Phase 7) ─────────────────

variable "placement_failure_window_seconds" {
  type        = number
  description = "Time window (seconds) to look back for blocked resource-exhaustion evaluations. The safety-net watcher polls the Nomad evaluations API and triggers emergency scale-out when blocked eval count exceeds the threshold within this window."
  default     = 300

  validation {
    condition     = var.placement_failure_window_seconds >= 60
    error_message = "placement_failure_window_seconds must be >= 60."
  }
}

variable "placement_failure_threshold" {
  type        = number
  description = "Number of resource-exhaustion blocked evaluations within the lookback window that triggers a safety-net scale-out. Set higher to reduce false positives; lower for faster reaction to capacity exhaustion."
  default     = 5

  validation {
    condition     = var.placement_failure_threshold >= 1
    error_message = "placement_failure_threshold must be >= 1."
  }
}

variable "placement_failure_cooldown_seconds" {
  type        = number
  description = "Minimum seconds between consecutive safety-net scale-out triggers. Prevents cascading scale-out events from the placement-failure watcher."
  default     = 600

  validation {
    condition     = var.placement_failure_cooldown_seconds >= 60
    error_message = "placement_failure_cooldown_seconds must be >= 60."
  }
}

# ── Admin Alerting (Phase 8) ───────────────────────────────

variable "alert_failure_threshold" {
  type        = number
  description = "Number of consecutive autoscale failures before an alert email is sent."
  default     = 3

  validation {
    condition     = var.alert_failure_threshold >= 1
    error_message = "alert_failure_threshold must be >= 1."
  }
}

variable "alert_rate_limit_seconds" {
  type        = number
  description = "Minimum seconds between consecutive alert emails. Prevents spam during persistent failures."
  default     = 3600

  validation {
    condition     = var.alert_rate_limit_seconds >= 300
    error_message = "alert_rate_limit_seconds must be >= 300 (5 minutes)."
  }
}

variable "alert_send_recovery" {
  type        = string
  description = "Whether to send a recovery email when the autoscaler resumes normal operation after a failure streak (true or false)."
  default     = "false"

  validation {
    condition     = contains(["true", "false"], var.alert_send_recovery)
    error_message = "alert_send_recovery must be 'true' or 'false'."
  }
}

variable "alert_smtp_host" {
  type        = string
  description = "SMTP relay hostname for sending alert emails. Leave empty to disable SMTP (falls back to logger)."
  default     = ""
}

variable "alert_smtp_port" {
  type        = number
  description = "SMTP relay port (typically 587 for STARTTLS, 465 for implicit TLS)."
  default     = 587
}

variable "alert_smtp_use_tls" {
  type        = string
  description = "Whether to use TLS when connecting to the SMTP relay (true or false)."
  default     = "true"

  validation {
    condition     = contains(["true", "false"], var.alert_smtp_use_tls)
    error_message = "alert_smtp_use_tls must be 'true' or 'false'."
  }
}

variable "alert_from" {
  type        = string
  description = "From address for alert emails (e.g. herobids-alerts@example.com)."
  default     = ""
}

variable "alert_to" {
  type        = string
  description = "Recipient address for alert emails (the default admin)."
  default     = ""
}

variable "alert_smtp_user" {
  type        = string
  description = "SMTP auth username. Leave empty if SMTP relay does not require authentication. Must be paired with alert_smtp_pass."
  sensitive   = true
  default     = ""
}

variable "alert_smtp_pass" {
  type        = string
  description = "SMTP auth password. Leave empty if SMTP relay does not require authentication. Must be paired with alert_smtp_user."
  sensitive   = true
  default     = ""
}
