# ── Outputs ────────────────────────────────────────────────

output "server_ipv4" {
  description = "Public IPv4 address of the server"
  value       = hcloud_server.default.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the server"
  value       = hcloud_server.default.ipv6_address
}

output "ssh_command" {
  value       = "ssh root@${hcloud_server.default.ipv4_address}"
  description = "Copy-paste SSH command to connect to the server"
}

output "frontend_url" {
  value       = "https://${var.app_domain}"
  description = "Frontend URL (web UI)"
}

output "api_url" {
  value       = "https://${var.app_domain}/api"
  description = "API base URL"
}
