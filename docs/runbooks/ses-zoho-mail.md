# SES + Zoho Mail — Operational Runbook

**Domain:** `openaidom.com`
**Last verified:** 2026-07-10

## Architecture

```
 ┌─────────────────────────────────────────────┐
 │                  openaidom.com               │
 │                                             │
 │  ┌──────────┐          ┌──────────────┐     │
 │  │ Zoho Mail │          │  Amazon SES  │     │
 │  │ (inboxes) │          │  (outbound)  │     │
 │  └────┬─────┘          └──────┬───────┘     │
 │       │  MX records           │  DKIM        │
 │       ▼                       ▼              │
 │  ┌──────────────────────────────────────┐    │
 │  │            Route 53 DNS              │    │
 │  │  MX + SPF + DKIM + DMARC            │    │
 │  └──────────────────────────────────────┘    │
 └─────────────────────────────────────────────┘
```

- **Zoho Mail** hosts human inboxes (support@, noreply@). MX records point here.
- **Amazon SES** sends application emails. Domain identity is verified with DKIM.
- **One SPF record** allows both Zoho and SES to send on behalf of the domain.
- **DKIM** is configured separately for Zoho and SES — both coexist.
- **DMARC** provides basic policy enforcement.

## Mailboxes

| Address | Provider | Purpose |
|---------|----------|---------|
| `support@openaidom.com` | Zoho Mail | User support, replies land here |
| `noreply@openaidom.com` | Zoho Mail | Application outbound sender identity |

## SES Configuration

Outbound email is sent by the worker via `apps/worker/src/alerting/ses-email-client.ts`.

**Required env vars:**
- `AWS_ACCESS_KEY_ID` — IAM user with `ses:SendEmail` permission
- `AWS_SECRET_ACCESS_KEY` — corresponding secret
- `AWS_REGION` — SES region (default: `us-east-1`)

**Optional env vars:**
- `EMAIL_PROVIDER=ses` — provider selector
- `EMAIL_FROM_EMAIL` — sender address
- `EMAIL_REPLY_TO_EMAIL` — reply-to address

The IAM policy requires:
```json
{
  "Effect": "Allow",
  "Action": "ses:SendEmail",
  "Resource": "*"
}
```

## Verification

See the full setup checklist: `docs/features/pending/100-ses-zoho-mail-migration/000-checklist.md`

Quick smoke test:
```bash
aws ses send-email \
  --from "noreply@openaidom.com" \
  --to "your-gmail@gmail.com" \
  --subject "SES smoke test" \
  --text "Sent from $(date)"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `email.auth_error` | Invalid/expired IAM credentials | Rotate `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `email.misconfigured` | Domain or email not verified in SES | Verify domain identity in SES console |
| `email.timeout` | Network connectivity to SES | Check outbound HTTPS (port 443) to `email.{region}.amazonaws.com` |
| Emails land in spam | Missing DKIM or SPF | Verify DKIM is enabled and passing in SES console; check SPF record includes `amazonses.com` |
| Replies go nowhere | MX not pointing to Zoho | Verify MX records in Route 53 point to `mx.zoho.com` |
