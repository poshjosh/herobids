---
name: echo-shell
description: Test-only fixture skill for the fictional example-echo external backend that declares a Bash dependency. Never publish.
allowed-tools: Bash(echo:*)
---
# Echo shell (test fixture)

Test fixture for network-free external-skill installation (Phase 3 T0.5).
Declares `allowed-tools: Bash(echo:*)` so add_skills' post-install Bash
detection auto-adds `system/programming`.
