# i18n Expansion

**Status:** blocked  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)  
**Prerequisite:** [Web i18n Completion](../../2026/08/23/002-web-i18n-completion/001-plan.md)

## Purpose

Decompose i18n expansion into ordered slices so server-side messaging,
Telegram, remaining emails, locale growth, and quality tooling can be planned
without pretending the web i18n prerequisite or first-wave locale decision is
already settled.

## Scope

This roadmap includes:

1. server-side i18n infrastructure for API and worker user-facing messages
2. Telegram localization for alerts, commands, and session anchors
3. remaining email localization beyond the login-link path
4. locale expansion and quality gates for larger translation surface area

This roadmap does not include:

1. the prerequisite web i18n completion work itself
2. login-link email localization already handled by the prerequisite track
3. admin-page localization
4. product-code implementation in this documentation step

## Non-Goals

1. Do not start implementation before the web i18n prerequisite is complete.
2. Do not hide the first-wave locale choice inside later task lists.
3. Do not localize operator-authored dynamic content in this slice.
4. Do not force a heavyweight server-side i18n runtime when a lighter resolver
   is sufficient.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after chat sessions, document handling, outbound
   attachments, and the external web i18n prerequisite.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [001-plan.md](./001-plan.md) remains the legacy source for the server-side
   resolver direction, channel coverage, locale expansion, and tooling choices.
4. The feature remains blocked until the named prerequisite is complete and the
   first locale wave is fixed explicitly enough for implementation.

## Fixed Decisions

1. Server-side user-facing messages use a lightweight domain-owned resolver and
   catalog model.
2. Telegram and remaining platform emails localize from the user's preferred
   locale after the prerequisite is satisfied.
3. Login-link email localization remains outside this feature because it is
   already owned by the prerequisite track.
4. Quality gates must address hardcoded strings and pluralization drift as the
   locale surface grows.
5. Locale expansion and tooling selection are real feature slices, not
   incidental cleanup.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. whether translation management remains manual or adopts dedicated tooling, as
   long as quality gates stay explicit
2. exact resolver and catalog helper boundaries, as long as locale-aware server
   messaging stays pure and testable

## Open Questions

1. Which locales belong in the first implementation wave beyond the existing
   set, and who owns that product decision?
2. Is machine translation acceptable as an initial source for the new locale
   wave, or must the feature wait for curated translations before execution?

## Child Docs And Sequence

Executable child docs to create in C09 after the prerequisite is cleared:

1. `002-server-side-i18n-infrastructure.md`
2. `003-telegram-localization.md`
3. `004-email-localization.md`
4. `005-locale-expansion.md`
5. `006-tooling-and-quality-gates.md`

Supporting task lists should not start until the prerequisite line above is
complete and the locale-wave decision is explicit.

## Acceptance Criteria

1. The roadmap states clearly why the feature is blocked and what unblocks it.
2. The child-doc order matches the legacy plan's progression from server
   infrastructure through channel localization, locale expansion, and tooling.
3. The feature-wide decisions preserve the split between prerequisite web work
   and later server/channel localization.
4. Later C09 and C10 work can resume from this roadmap without guessing the
   blocker or the intended decomposition.

## Validation

1. Compared the blocked status, prerequisite line, and child-doc sequence
   against [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
