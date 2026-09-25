# Task: CC-1 — Design system refactor, mock dataset, and agent-facing design docs

## Objective

Refactor the Pulse design system so every page looks intentional (no more
browser-default form controls, misaligned Settings/Fleet/Alerts/Clients
layout, ad-hoc inline styling), back the whole UI with a rich mock dataset
that is one flag away from real data, and document the system with
progressive disclosure so future agent sessions pick it up automatically.

Drivers (user-reported): Settings, Fleet explorer, Alerts, Clients pages still
have layout/alignment deficiencies; Alerts dropdowns are ugly; agents keep
re-inventing UI markup because there is no enforced design contract.

## Audit findings (2026-09-25, verified in tree)

1. **Form controls are the #1 visible defect.** `.input` is opt-in per element:
   16 of 23 form inputs are unstyled browser defaults; **all 9 `<select>`s**
   (Alerts rule builder ×3, Fleet explorer ×2, Analysis, Energy, Recipes,
   Models) render with native OS chrome — the "ugly dropdowns". No
   `appearance: none`, no chevron, no shared height.
2. **Undefined selectors/tokens**: `className="row between"` and
   `className="doctor-row"` have no CSS (NodePage, OverviewPage, ModelsPage);
   `--bg-2`/`--fg-2` are referenced with fallbacks in ClientsPage,
   AnalysisPage, ServePage console but never defined — the dark `pre` blocks
   are accidental one-offs.
3. **~200 inline `style={{}}` blocks** across all 13 pages: layout primitives
   (flex gaps, margins, widths) authored per-page — the direct cause of the
   misalignment between sibling controls (Alerts builder mixes flex-1 inputs
   with 90px numbers; Settings grid uses `auto-fit minmax(150px)`).
4. **No spacing scale / no layout utilities**: gaps, margins, widths are magic
   numbers; `.field` exists but is Settings-only (230px label, one row shape).
5. **Hardcoded demo residue in product paths**: Overview sub-line
   "2× DGX Spark (GB10) · QNAP NAS store · gateway on http://cc.home.local/v1",
   brand footer "home.local", RouterPage default target `dgx1:8081` — fleet-
   specific strings shipped to every deployment.
6. **Fake fleet covers only node metrics/jobs** (`server/src/fakeFleet.ts`):
   Clients, Analysis, Alerts, Energy, Models, Serve pages have **no seed
   data**, so during development they always render empty — regressions are
   invisible and there is no way to review the full UI without a live fleet.
7. **No design documentation anywhere**; `AGENTS.md`/`docs/README.md` never
   mention the UI. Nothing tells an agent "styling lives in pulse.css, use
   these primitives". The stale-milestone-copy bug class will recur.
8. Partial fixes already shipped (heading normalization, `.table` styling,
   live Overview KPIs, "System" nav section) — build on top, don't redo.

## Approach

Three teammate lenses applied at each phase:
- **Product**: honest empty/loading/error states, data shown where it exists,
  no vendor/demo copy, consistent action grammar (primary action rightmost).
- **UI/UX**: one control height scale, aligned forms, uppercase table headers,
  visible focus, light+dark parity, density via tokens not per-page choice.
- **Frontend**: styling single-sourced in `pulse.css` classes; pages compose
  primitives, never hand-roll layout; no new dependencies; CSS-first.

**Mock-data strategy (the "disconnect seam")**: the `--fake-fleet` flag is the
only mock mechanism, server-side only. Extend it to seed the missing domains
(clients/traces/alerts/energy/models) into the same SQLite/registries the real
routes read. The web app contains **zero mock logic** — run without the flag
and every page reads real data. That is the easy disconnect the user asked
for; documented in the design-system doc.

## Plan

### P0 — Baseline and harness (0.5 d)
- [x] Boot `--fake-fleet`, screenshot all 13 pages light @1568 as the "before"
      set (reused after each phase). — done via `cc-ui-visual-review` boot on :5599.
- [x] Confirm every page fetches via `web/src/api/*` only (grep for raw
      `fetch(` outside that layer; fix leaks) — the seam requirement.

### P1 — Design-system foundation in `pulse.css` (1 d)
- [x] Tokens: spacing scale `--s1…--s8` (4→32 px), control heights
      (`--ctl-h: 32px`, `--ctl-h-sm: 26px`), shadow set, focus ring
      (`outline: 2px solid var(--accent)` on `:focus-visible`), and define
      `--bg-2`/`--fg-2` (terminal surfaces) for real.
- [x] Global form reset: `input, select, textarea` styled by default (drop the
      per-element `className="input"` burden; keep the class as alias);
      `select { appearance: none }` + inline-SVG chevron + hover/focus states.
- [x] Layout utilities: `.row`, `.row-between`, `.stack`, `.wrap`, `.grow`,
      `.gap-*` — replaces repeated inline flex blocks.
- [x] `.toolbar` (page action bars), `.form-grid` (aligned label/control forms,
      `.field` becomes its row with vertical + inline variants), `.spacer`.
- [x] `.callout` (ok/info/warn/crit) for all message/error banners; `.col-act`
      (right-aligned action cells), `.cell-sub` (hint line under table names).
- [x] Empty-state pattern (`.empty` + `.empty-action` for guidance copy).
- [x] Remove the undefined-class debt: `.row`/`.between`/`.doctor-row` defined
      or their usages replaced; `pre.code-block` for consoles/key reveals.
- [x] Mobile rules extended to every new utility; dark-theme spot check.

### P2 — Shared React primitives + styleguide (1 d)
- [x] `web/src/ui/`: `Field`, `Segmented`, `Toolbar`, `Callout`, `EmptyState`,
      `DataTable` (table + sticky header + `.col-act`), `Kpi`, `DetailList`,
      `KeyBlock` (one-time secret reveal), `FormRow`. Thin: they render the
      P1 classes; no styling logic in JS.
- [x] Dev-only **/styleguide** page rendering every token/primitive/state
      (light+dark). Doubles as the agent's visual contract and the review
      target for screenshot passes.
- [x] Replace hardcoded product copy: Overview sub-line derived from live
      node directory (`N nodes · gateway /v1`), brand env from `/api/health`
      config, Router default target `—` placeholder (no `dgx1:8081`).

### P3 — Page-by-page refactor (1.5 d) — user-called-out first
- [x] **Settings**: every panel body becomes `.form-grid`; capture checkbox
      gets label styling; nodes registry rows become `.table`; system actions
      into `.toolbar`; retention number inputs aligned on the same grid.
- [x] **Alerts**: rule builder → two-row `.form-grid` (name / source / metric,
      then op / value / hold / severity / save), all controls shared height;
      Active/All toggle → `.segmented`; three tables via `DataTable`.
- [x] **Fleet explorer**: domain picker → `.segmented`; metric + range selects
      styled; chart legend rows use `.row-between` + `.cell-sub`.
- [x] **Clients**: create form → `.form-grid`; `KeyBlock` with the defined
      terminal tokens; scopes as `.chip`s in a fixed column; revoke confirm
      inline via `.callout warn`.
- [x] **Pass over remaining pages**: Overview, Node, Models, Serve, Recipes,
      Router, Analysis, Energy, Chat — replace inline layout with P1/P2
      primitives, banners → `.callout`, filter inputs → `.input` default.
- [x] Copy sweep: imperative labels, consistent capitalization, no "…" stubs.

### P4 — Mock dataset for every surface (1 d)
- [x] `server/src/mockData.ts` (fake-fleet mode only): 4 gateway clients with
      usage rows; ~40 request traces across 24 h incl. 5xx + slow TTFT; 1
      firing alert + 1 resolved + history events; energy rollups (hourly/
      daily/monthly, 2 nodes); 5-model store inventory + presence + 1
      completed/1 failed job; 2 recipes + 1 deployment with pass-through.
- [x] Deterministic seed (fixed PRNG) so screenshots and e2e stay stable.
- [x] e2e spec: each previously-empty page now shows seeded rows (guards the
      seam: real mode must show its own empty states — assert both).
      (`e2e/mock-seam.spec.ts`)
- [x] Verify `npm run dev` (no flag) still renders honest empty states.

### P5 — Progressive-disclosure documentation (0.5 d)
- [x] **`docs/DESIGN_SYSTEM.md`** (new, T1): token tables, primitive inventory,
      hard rules (no inline color/margin/width; forms use `.form-grid`; pages
      fetch via `web/src/api/*`; mocks only via `--fake-fleet`), per-page
      checklist, screenshot procedure.
- [x] **AGENTS.md**: T1 row points at DESIGN_SYSTEM.md when the task touches
      `web/`; Working Agreement gains one line: UI changes follow it.
- [x] **docs/README.md**: add to "When needed" tier (task touches `web/src` or
      `pulse.css`).
- [x] **docs/DEVELOPMENT_PROCESS.md** §Implement: design-system bullet.
- [x] `pulse.css` header comment: pointer to the doc + styleguide route.
- [x] Update `docs/DEVELOPMENT_STATUS.md` + `.agentic/bin/docs-check` green.

### P6 — Verification and ship (0.5 d)
- [x] `npx tsc -p web && npx tsc -p server`, `npm test`, `npm run build`,
      `npm run test:e2e`, `.agentic/bin/validate`, `.agentic/bin/docs-check`.
- [x] Browser pass: all 13 pages + styleguide, light **and dark**, desktop
      1568 and phone 390 — compared against P0 baseline screenshots.
- [ ] Commit per phase (P1+P2, P3, P4, P5), push.

## Acceptance criteria

- [ ] No unstyled form control remains (zero bare `input`/`select`/`textarea`).
- [ ] Settings, Alerts, Fleet explorer, Clients pass an alignment review:
      every control in a form shares height + baseline; every table uses the
      DS table.
- [ ] No page references undefined classes or undefined CSS custom properties.
- [ ] Fleet-specific strings (dgx1:8081, cc.home.local, 2× DGX) are gone from
      product paths.
- [ ] `--fake-fleet` exercises every page with data; removing the flag is the
      only step to switch to real data (no web-side mock code exists).
- [ ] /styleguide renders every primitive in both themes.
- [ ] docs/DESIGN_SYSTEM.md exists, indexed per progressive-disclosure tiers;
      AGENTS.md routes a `web/`-touching task into it.
- [ ] All gates green; e2e includes the mock-seam test.

## Scope

### Included
- `web/src/**`, `web/index.html`, `server/src/fakeFleet.ts`, `server/src/mockData.ts`,
  `docs/DESIGN_SYSTEM.md` + doc index/process edits, `AGENTS.md` tier row,
  e2e specs.

### Excluded
- New UI dependencies/frameworks (no Tailwind/Radix/MUI).
- REST/WS API contract changes; auth; charts library; power-management
  behavior; the live dgx-1 redeploy (owner approval separate).

## Architecture impact

- **ADR required:** No — presentation layer + dev-mode seeding only; no data
  model, transport, or deployment boundary changes. (Mock seeding lives in
  the existing `--fake-fleet` dev flag; production code paths untouched.)

## Validation evidence

- Configuration validation: pending
- Tests: pending
- Build: pending
- Documentation check: pending

## Review

- Correctness: pending
- Security: mock data contains no secrets; key reveal UI shows only synthetic.
- Compatibility: existing testids preserved; e2e suite must stay green.
- Residual risks: P3 touches all pages — screenshot baseline guards regressions.
