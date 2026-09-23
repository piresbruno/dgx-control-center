# ADR-0008: Pulse DS — bespoke tokens on Tailwind v4 + Radix/shadcn

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** web
- **Tags:** design-system, ux
- **Supersedes:** None
- **Superseded by:** None

## Context

sparkControl's UI is functional but ad hoc; the owner wants an enterprise-grade, calm, scalable interface. Three skins (Meridian / Softline / Slate Pro) were mocked and Option C selected.

## Decision drivers

- Enterprise aesthetic: neutral, one accent, semantic color only for states (user feedback after v1 mockups).
- Accessibility without hand-rolling every primitive (dialog focus, traps, aria).
- Mobile-first; airy density contract; equal dark token map.

## Considered options

### Option 1 — Pulse DS: Tailwind v4 tokens + Radix/shadcn (selected)

Bespoke token layer ("Slate Pro": enterprise blue, light-first, airy, mobile-first) with accessible behavior primitives from Radix/shadcn; uPlot for dense time-series.

### Option 2 — MUI

Fast to assemble but visually opinionated and heavy; fights the approved aesthetic.

### Option 3 — Fully hand-rolled primitives

sparkControl already paid the a11y/dialog tax; not repeating it.

## Decision

Pulse DS per mockups in `design/mockups/` (chooser + A/B retained for reference); Option C "Slate Pro" promoted to the base token map.

## Consequences

### Positive

- Full visual control; primitives inherit WCAG-grade behavior; dark mode is a token map, not a rewrite.

### Negative

- Token discipline must be enforced (lint against raw hex in components).

### Risks and mitigations

- Chart color drift: series palette fixed in tokens; reduced-motion respected.

## Implementation and validation

Mockup set user-approved; web package adopts tokens from M1 onward (Overview/Node pages first); Playwright smoke on fake fleet guards layout at M1+.

## Revisit triggers

- New page types that the token system cannot express without hacks.

## References

- design/mockups/ (chooser + pages), PLAN.md §9, docs/adr/0002 (state enum surfacing)
