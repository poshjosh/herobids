# Production Final Push — Nomad Scale-In Enablement

Auto-scaling has been configured for staging and validated exhaustively (V1–V8 passed). This checklist propagates those changes to production.

## Prerequisites

- Remediation plan (001) complete
- Externalize secrets plan (001b) complete
- Validation plan (002) passed on staging
- S3 backend migrated for both staging and production
- `.env.backend` contains valid AWS and backend credentials

## Checklist

### 1. Enable scale-in and set production values in `production.tfvars`

Uncomment and set:

```hcl
# ── Scale-In Configuration (Phase 7) ───────────────────────
enable_scale_in                    = true
min_agent_nodes                    = 1     # never scale to zero in production
scale_in_drain_deadline_seconds    = 900   # 15 min — production agents need more drain time
scale_in_max_nodes_per_run         = 1     # one at a time — conservative
scale_in_time_utc                  = 3     # 3 AM UTC — quiet hours

# ── Placement-Failure Safety Net (Phase 7) ─────────────────
placement_failure_window_seconds   = 300
placement_failure_threshold        = 3     # more sensitive than staging's 5
placement_failure_cooldown_seconds = 900   # 15 min — prevent alert storms
```

### 2. Configure SMTP alerts (optional but recommended)

You need an SMTP relay that can send email. You already have AWS — use Amazon SES.

**Steps:**

a) **Enable SES in AWS console** — verify your sender domain or email address in SES (`us-east-1`). If your account is in the SES sandbox, you also need to verify the recipient address.

b) **Get SMTP credentials** — In the SES console, go to "SMTP settings" and create SMTP credentials. This gives you a username and password (different from your regular AWS keys).

c) **Set the values in `production.tfvars`:**

```hcl
# ── Admin Alerting (Phase 8) ───────────────────────────────
alert_failure_threshold    = 3
alert_rate_limit_seconds   = 3600
alert_send_recovery        = "true"
alert_smtp_host            = "email-smtp.us-east-1.amazonaws.com"
alert_smtp_port            = 587
alert_smtp_use_tls         = "true"
alert_from                 = "alerts@openaidom.com"     # must be verified in SES
alert_to                   = "your-email@example.com"   # your admin email
alert_smtp_user            = "AKIA..."                  # SES SMTP username (not your regular AWS key)
alert_smtp_pass            = "..."                      # SES SMTP password
```

If you don't want to use SES, any SMTP relay works (Mailgun, SendGrid, Postmark, Gmail with app password). This isn't blocking — alerts fall back to syslog if SMTP isn't configured.

### 3. Provision production with the new config

```bash
cd infra/hetzner
./scripts/provision.sh --env production --var-file production.tfvars
```

This applies the scale-in and alerting config to the production control plane's cloud-init.

### 4. Run setup-nomad.sh for production

Production Nomad needs ACL bootstrap, credential deployment, and verification — same as staging.

```bash
infra/hetzner/scripts/setup-nomad.sh --env production \
  --env-file .env.prod --backend-env-file .env.backend
```

This will:
- Deploy `.env.prod` and `autoscale.env` to the production server
- Wait for Nomad to be healthy
- Bootstrap ACLs (or skip if token already in `.env.backend`)
- Save the token to `.env.backend` and `.env.prod`
- Redeploy with the token
- Verify health

### 5. Test alert delivery (if SMTP configured)

```bash
ssh root@<production-ip> '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test'
```

Check your inbox for the test alert email.

### 6. Run the smoke test against production

```bash
scripts/shell/tests/autoscale-smoke-test.sh --env production
```

All 18 checks should pass (the staging hooks check is skipped for production).

### 7. Monitor the first nightly scale-in

The first automated scale-in runs at 3 AM UTC. Watch it:

```bash
# On the production control plane
ssh root@<production-ip>

# Watch the scale-in timer
systemctl list-timers nomad-scale-in.timer

# After 3 AM UTC, check what happened
journalctl -u nomad-scale-in -n 50
tail -50 /var/log/nomad-autoscale.log

# Check node status
source /etc/herobids/autoscale.env
NOMAD_TOKEN=$NOMAD_TOKEN nomad node status
```

Expected outcomes:
- **If idle nodes exist:** one node drained and removed, log shows "Scale-in successful"
- **If all nodes have work:** log shows "No idle nodes to scale in" — correct, nothing to do
- **If already at min_agent_nodes:** log shows "Already at or below min_agent_nodes" — correct

If anything unexpected happens, check the autoscale log and the alert email (if configured).

## Done

Production scale-in is enabled when all 7 steps are complete and the first nightly run is observed.
