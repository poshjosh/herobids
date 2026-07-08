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
  description = "Application domain name. Convention: herobids.com (production), staging.herobids.com (staging)."
  default     = "herobids.com"
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
  default     = "cpx21"

  validation {
    condition     = can(regex("^(cx|ccx|cpx|CAX)\\d+$", var.agent_node_server_type))
    error_message = "agent_node_server_type must be a valid Hetzner instance type (e.g., cpx21, cx32, ccx53)."
  }
}
