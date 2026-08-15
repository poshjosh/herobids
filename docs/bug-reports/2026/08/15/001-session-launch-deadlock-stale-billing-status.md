# 001 — Stale `hard_limited` billing status deadlocks agent session launches

- **Status:** OPEN
- **Severity:** LOW (because the button is removed for now)
- **Date:** 2026-08-15
- **Environment:** staging (Hetzner, staging.openaidom.com)

## Summary

On the billing page, the "Manage billing" button does not work. The button has been removed for now. (See commit 375193e215a54a2f876559283adb36213d2b518d) Investigate the following:

- What the button is supposed to do
- The root cause of it's malfunction
- Best durable fix