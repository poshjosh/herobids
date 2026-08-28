# IMPORTANT ISSUE TO BE FIXED

## Design Issue: `agent_node_count` in cloud-init triggers unnecessary server replacement

**Problem:** `agent_node_count` is passed as a template variable into `cloud-init.yaml` (line 422), where it seeds `/var/run/nomad-autoscale-node-count`. Because `user_data` is an immutable attribute on `hcloud_server.default`, any change to `agent_node_count` changes the `user_data` hash, and Terraform concludes the control-plane server must be destroyed and recreated — even though the only thing that changed is a runtime seed value for the autoscaler.

This means you can't run `terraform apply -var="agent_node_count=1"` from your local machine without Terraform wanting to rebuild the entire control-plane server. That's disproportionate — you're adding a cattle node but Terraform wants to kill the control plane.

**Why it exists:** The seed file tells the autoscaler what the current node count is on first boot, before any scale events have occurred. Without it, the autoscaler wouldn't know how many nodes exist.

**Why it's wrong:** The autoscaler overwrites this file at runtime (via `write_node_count` in `scale-out.sh`). After first boot, the cloud-init seed is never used again. Embedding it in `user_data` couples a one-time runtime seed to the server's immutable identity.

**Fix options:**
1. Remove `agent_node_count` from the cloud-init template. Instead, have the autoscaler read the current count from Terraform state (`terraform show -json | jq ...`) on first run when the file doesn't exist.
2. Keep the seed but use a static placeholder (e.g., always `0`) in cloud-init, and set the real value via a `null_resource` provisioner or a separate remote-exec that doesn't affect `user_data`.
3. Use `ignore_changes = [user_data]` on `hcloud_server.default` after initial provisioning — but this suppresses all cloud-init changes, which is too broad.

Option 1 is the cleanest.