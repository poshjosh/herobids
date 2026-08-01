# ADR 002: Template Versus Instance Boundary

**Date:** 2026-08-01
**Status:** Accepted

## Context

Agent configuration is currently split across typed agent columns, unified configuration, skills, and operational policy fields. Some of that data is shareable recipe data, and some of it is user-private or runtime-only.

Without an explicit boundary, copied blueprints either leak private state or silently lose behavior.

## Decision

**Blueprint content contains only template-eligible data.**

**Instance creation supplies private bindings and runtime-owned state separately.**

Specifically:

1. The server owns the template-versus-instance projection rules.
2. Browser payload assembly must not decide which fields are shareable.
3. A field that materially changes behavior must be classified as template-eligible or instance-only before implementation is considered complete.
4. Published blueprints must never store secrets, private account ownership data, or runtime state.
5. Save-as-blueprint and instantiate-from-blueprint flows must run through server-owned projection helpers.

### Template-eligible surface

The template surface includes, where relevant:

1. prompt or goal
2. skill assignments
3. style
4. typed strategy identity
5. technical configuration
6. intelligence configuration
7. execution defaults
8. risk posture
9. capital defaults where applicable
10. operational policy that materially changes behavior
11. marketplace metadata and lineage

### Instance-only surface

The instance surface excludes at least:

1. connection and venue account bindings
2. credentials and secret references
3. private destinations such as `telegramChatId`
4. pause state and session state
5. runtime self-adjustments such as `riskOverrides`
6. open positions, fills, P and L, and runtime analytics
7. per-user ownership and delivery details

## Rationale

1. Without a hard boundary, copied blueprints either leak private state or silently lose important behavior.
2. The server is the only reliable place to enforce one classification rule across API, UI, and future clients.
3. Treating projection as a first-class server concern gives the system a testable definition of blueprint completeness.
4. This boundary is the core defense against "looks the same but behaves differently" copies.

## Consequences

### Positive

1. Blueprints become safe to publish and copy.
2. Runtime instances can be recreated faithfully with only missing private inputs supplied.
3. Server-side tests can prove both completeness and exclusion.

### Negative

1. Projection logic becomes an explicit design surface that must be maintained carefully.
2. Some fields that currently feel like ordinary agent settings must be classified explicitly before implementation can proceed.

## Follow-Up Rules

1. Any field that materially changes behavior must be classified as template-eligible or instance-only.
2. Private bindings and runtime state must never be stored in published blueprints.
3. Save-as-blueprint and instantiate-from-blueprint flows must be backed by server-owned projection helpers.
