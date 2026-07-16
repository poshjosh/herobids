BACKGROUND

We implemented this: docs/features/2026/07/11/004-hybrid-mode-split/001-plan.md

We then discovered that the implementation had gaps which meant scanner gated agents never received any trading related signals.

The following are feature plans and bug reports which we have implemented and fixed accordingly towards ensuring scanner gated agents receive signals relating to trade options.

- docs/features/2026/07/15/002-technical-data-for-agents/001-plan.md
- docs/bug-reports/2026/07/15/002-technical-scanner-filters-never-populated.md
- docs/bug-reports/2026/07/15/003-patch-preset-technical-null-collision.md
- docs/features/2026/07/16/001-apply-technical-config-defaults/001-plan.md
- docs/bug-reports/2026/07/16/003-technical-config-scan-defaults-not-applied-at-load.md

We have also used the following scripts to test the feature:

- scripts/shell/tests/agent-config-matrix-test.sh
- scripts/shell/tests/agent-config-defaults-smoke-test.sh

The second script is still buggy (only 5 of 9 tests pass as at last check)

We have now received this report docs/features/2026/07/16/003-scanner_gated-must-be-working/001-investigation-of-current-deployment.md which shows that scanner gated agents do not receive the expected signals

DO NOT RELY ON THE DOCUMENTS TO BE ACCURATE, IF YOU NEED TO, SSH INTO THE REMOTE SERVER USING SCRIPTS IN infra/hetzner/scripts/ - the app is deployed to staging environment

INSTRUCTIONS

Analyse info from the background, from the code and anywhere else you think necessary 

Explain what problem currently prevents scanner_gated agents from functioning properly

Investigate what yet to be uncovered problem may potentially prevent scanner_gated agents from functioning properly

Outline how we can fix the above problems

Outline how we can accurately verify the fix end - to -end before releasing to staging

Do not jump into coding, implementing or fixing yet

If you choose to produce documents, save them sequentially inside docs/features/2026/07/16/003-scanner_gated-must-be-working/

DO NOT ASSUME ANYTHING, IF NEED ASK CLARIFYING QUESTIONS

