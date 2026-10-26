# Open questions

**Closed on 2026-10-25.** Every question raised so far is decided. The decisions are in [DECISIONS](./DECISIONS.md).

| Was | Question | Decision |
| --- | --- | --- |
| OPEN-01 | Second chat provider target | DEC-30: Telegram, web push and email for now |
| OPEN-02 | Approve the two-way chat plan (002) | DEC-31 and DEC-32: approved, run after C1, with the section 9 answers |
| OPEN-03 | Owner merge gate for C2 | DEC-33: independent reviewer agent, no human gate |
| OPEN-04 | `POST /agents/verify-telegram` | DEC-34: removed 2026-10-26 |
| E-D3 and E-D4 | Email fallback rules | DEC-35: email only when no other channel delivered; opt-in kept |
| E-D6 | Older email paths | DEC-36: out of scope |
| W D1 to D8 | Web push defaults | DEC-37: confirmed |
| E7 | `PATCH /auth/me` additive field | DEC-38: accepted |
| D09 | Billing default model | DEC-39: pass-through; invoice check before WhatsApp launch |

## Owner hand-offs still open

- M-E5: SES bounce and complaint metrics after the first real send.
- DEC-39: invoice check, before any WhatsApp launch.
- Staging and production teardown and re-provisioning, after C1 (DEC-13).
