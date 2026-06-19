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
  description = "Server hostname"
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
  description = "Application domain name"
  default     = "herobids.com"
}
