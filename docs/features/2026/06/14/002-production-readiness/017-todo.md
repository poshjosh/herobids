turn the dry-run into final Stage 4 proof.

Why: 016-venue-validation-results.md says the run was `Dry-run (quote + safety enforcement, no on-chain execution)`, while 015-final-mvp-validation-and-release-evidence.md requires real venue proof for swap submission, confirmation, and persisted execution evidence.

So the simple next step is:
1. Set `ONEINCH_ROUTER_ADDRESS`.
2. Fund the Jupiter and 1inch validation wallets.
3. Re-run:
   - `bash validate-jupiter.sh --execute`
   - `bash validate-1inch.sh --execute`
4. Update 016-venue-validation-results.md with the live execution results.
5. Write the final release summary artifact required by 015-final-mvp-validation-and-release-evidence.md.

The important catch is 1inch: with the current warning, I would not treat full MVP release as closed yet, because your own rule in 015-final-mvp-validation-and-release-evidence.md says 1inch launch evidence should not depend on missing `routerAddress`.

So the short answer is: configure `routerAddress`, do the live `--execute` runs, then produce the final release summary.