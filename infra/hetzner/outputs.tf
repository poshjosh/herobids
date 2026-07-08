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
