---
name: crypto-trading
description: Submit trade decisions and inspect trading state across the Traderton venues. Test-only hermetic fixture mirroring the T4.1 crypto-trading skill. Never publish.
---
# Crypto Trading (test fixture)

Hermetic in-repo fixture for the Phase 3 T4.3 end-to-end publication test.
Mirrors the published `traderton/skills@crypto-trading` skill: install ref
`traderton/skills@crypto-trading` normalizes to source ref
`traderton/skills/crypto-trading`, which the committed dev descriptor approves
and binds to the crypto-trading tool set. Content is deliberately minimal; the
authoritative tool surface comes from the signed descriptor, not this body.
