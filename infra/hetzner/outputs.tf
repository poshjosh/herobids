# ── Outputs ────────────────────────────────────────────────

output "environment" {
  value       = var.environment
  description = "Deployment environment (staging or production)"
}

# ── Control Plane ─────────────────────────────────────────

output "server_ipv4" {
  description = "Public IPv4 address of the control-plane server"
  value       = hcloud_server.default.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the control-plane server"
  value       = hcloud_server.default.ipv6_address
}

output "control_plane_private_ip" {
  description = "Private IP of the control-plane server on the environment's private network"
  value       = var.enable_nomad ? hcloud_server_network.control_plane[0].ip : null
}

output "ssh_command" {
  value       = "ssh root@${hcloud_server.default.ipv4_address}"
  description = "Copy-paste SSH command to connect to the control-plane server"
}

output "frontend_url" {
  value       = "https://${var.app_domain}"
  description = "Frontend URL (web UI)"
}

output "api_url" {
  value       = "https://${var.app_domain}/api"
  description = "API base URL"
}

# ── Nomad Cluster ─────────────────────────────────────────

output "nomad_enabled" {
  value       = var.enable_nomad
  description = "Whether Nomad orchestration is provisioned for this environment"
}

output "nomad_server_addr" {
  description = "Nomad server HTTP API address (private network). Use this to configure NOMAD_ADDR for CLI and the worker Nomad adapter."
  value       = var.enable_nomad ? "http://${hcloud_server_network.control_plane[0].ip}:4646" : null
}

output "private_network_id" {
  description = "ID of the environment's private network"
  value       = var.enable_nomad ? hcloud_network.private[0].id : null
}

output "private_network_ip_range" {
  description = "CIDR range of the environment's private network"
  value       = var.enable_nomad ? hcloud_network.private[0].ip_range : null
}

# ── Agent Node Pool ───────────────────────────────────────

output "agent_node_count" {
  description = "Number of agent (Nomad client) nodes provisioned"
  value       = var.agent_node_count
}

output "min_agent_nodes" {
  description = "Minimum number of agent nodes (scale-in floor)"
  value       = var.min_agent_nodes
}

output "max_agent_nodes" {
  description = "Maximum number of agent nodes (scale-out ceiling)"
  value       = var.max_agent_nodes
}

output "agent_node_public_ips" {
  description = "Public IPv4 addresses of agent nodes"
  value       = var.enable_nomad ? hcloud_server.agent[*].ipv4_address : []
}

output "agent_node_private_ips" {
  description = "Private IPs of agent nodes on the environment's private network"
  value       = var.enable_nomad ? hcloud_server_network.agent[*].ip : []
}

output "agent_node_names" {
  description = "Hostnames of agent nodes"
  value       = var.enable_nomad ? hcloud_server.agent[*].name : []
}

output "agent_ssh_commands" {
  description = "Copy-paste SSH commands to connect to each agent node"
  value = var.enable_nomad ? [
    for i, ip in hcloud_server.agent[*].ipv4_address :
    "ssh root@${ip}"
  ] : []
}

# ── Autoscale Configuration ───────────────────────────────

output "scale_out_cooldown_seconds" {
  description = "Minimum seconds between consecutive scale-out operations"
  value       = var.scale_out_cooldown_seconds
}

output "scale_out_memory_threshold_pct" {
  description = "Free memory percentage below which scale-out triggers"
  value       = var.scale_out_memory_threshold_pct
}

output "scale_out_slot_threshold" {
  description = "Free agent slots below which scale-out triggers"
  value       = var.scale_out_slot_threshold
}

output "scale_out_increment" {
  description = "Number of agent nodes to add per scale-out event"
  value       = var.scale_out_increment
}

output "agent_memory_reservation_mb" {
  description = "Scheduling memory reservation per agent slot (MB)"
  value       = var.agent_memory_reservation_mb
}

# ── Scale-In Configuration (Phase 7) ──────────────────────

output "enable_scale_in" {
  description = "Whether nightly scale-in is enabled"
  value       = var.enable_scale_in
}

output "scale_in_drain_deadline_seconds" {
  description = "Maximum seconds to wait for a draining node to empty"
  value       = var.scale_in_drain_deadline_seconds
}

output "scale_in_max_nodes_per_run" {
  description = "Maximum nodes to drain per nightly scale-in run"
  value       = var.scale_in_max_nodes_per_run
}

output "scale_in_time_utc" {
  description = "UTC hour for nightly scale-in (0-23)"
  value       = var.scale_in_time_utc
}

# ── Placement-Failure Safety Net (Phase 7) ─────────────────

output "placement_failure_window_seconds" {
  description = "Time window for counting placement-failure evaluations"
  value       = var.placement_failure_window_seconds
}

output "placement_failure_threshold" {
  description = "Blocked evals in window to trigger safety-net scale-out"
  value       = var.placement_failure_threshold
}

output "placement_failure_cooldown_seconds" {
  description = "Minimum seconds between safety-net scale-out triggers"
  value       = var.placement_failure_cooldown_seconds
}
