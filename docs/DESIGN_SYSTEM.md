# Design System — Pulse

The single source of truth for how the dashboard (`web/`) looks and is built.
Read this **before** touching anything under `web/src/`. Skim it once and
return to the tables when writing a page.

**Live reference:** the **Styleguide** page in the app (dev builds, sidebar →
System → Styleguide) renders every token, primitive, and state — including
dark theme. Compare new work against it.

## Hard rules

1. **Styling lives in `web/src/styles/pulse.css`.** Pages compose its classes;
   they do not author layout CSS. **No inline `style={{…}}`** for color,
   margin, padding, gap, font size, or width.
   Allowed inline exceptions (data-driven only): computed bar/meter widths
   (`width: ${pct}%`), per-series chart colors, and a one-off
   `gridTemplateColumns` when no utility fits — add a class instead when the
   pattern repeats twice.
2. **Use the primitives in `web/src/ui/index.tsx`** (below) before writing new
   markup for forms, toolbars, banners, tables, KPIs, or empty states.
3. **Form controls need no class.** `input`, `select`, `textarea` are styled
   globally (incl. a custom chevron on selects). `className="input"` is a
   legacy alias — do not add new ones.
4. **The data seam:** every page reads/writes through `web/src/api/*`
   (`apiGet/apiPost/apiPatch/apiPut/apiDelete` in `api/client.ts`). **No mock
   data exists in `web/`.** The only mock mechanism is the server's
   `--fake-fleet` mode (`server/src/fakeFleet.ts` + `server/src/mockData.ts`),
   which seeds the same SQLite tables / stores / job channels the real fleet
   fills — so the identical UI switches to real data by dropping the flag.
   Never add fetch bypasses, fixture imports, or `if (demo)` branches to pages.
5. **No fleet-specific strings in product paths** (`dgx1:8081`,
   `cc.home.local`, model names…). Derive from the node directory / config or
   use neutral placeholders.
6. **Never resurrect roadmap-stage copy** ("arrives with M…", "Coming in
   later milestones"). Copy describes what the product does today.
7. Preserve `data-testid` attributes when refactoring markup — the e2e suite
   (`e2e/`) and CI depend on them.

## Tokens (`:root`, mirrored under `[data-theme="dark"]`)

| Group | Tokens |
|---|---|
| Surfaces | `--bg` `--surface` `--raised` `--overlay` `--bg-2` `--fg-2` (terminal) |
| Lines | `--hairline` `--hairline-2` |
| Text | `--text-1` (primary) `--text-2` (secondary) `--text-3` (muted) |
| Accent | `--accent` `--accent-hi` `--accent-dim` |
| Semantic | `--ok/-dim` `--warn/-dim` `--crit/-dim` `--info/-dim` |
| Chart series | `--series-1 … --series-5` |
| Spacing | `--s1 4px --s2 8px --s3 12px --s4 16px --s5 20px --s6 24px --s8 32px` |
| Control heights | `--ctl-h 34px` `--ctl-h-sm 28px` (buttons match) |
| Radii / effects | `--r-sm --r-md --r-lg` `--focus` `--shadow-1` `--shadow-2` |
| Type | `--font-ui` (Inter stack) `--font-mono` (JetBrains Mono stack) |

## Primitives (`web/src/ui/index.tsx`)

| Component | Use for |
|---|---|
| `FormGrid` + `Field` | Any labelled form: one aligned 230px label column, uniform control heights. `hint`/`required`/`top` props included. |
| `FormRow` | Dense filter bars of unlabeled controls (wraps on mobile). |
| `Toolbar` | Panel action bars (buttons/links in a row). |
| `Segmented<T>` | Mutually-exclusive toggles (views, windows, buckets). When per-button `data-testid`/`disabled`/`title` are needed, hand-roll the identical `<div className="segmented">` markup instead. |
| `Callout` / `ErrorBanner` | Every success / info / warning / error message. Never raw colored `<div>`s. |
| `EmptyState` | Empty panels; optional `action` slot pointing at the next step. |
| `TableScroller` | Any `.table` inside a panel (handles flush padding + mobile overflow; `maxHeight` for capped history panes). |
| `ActionTh` / `ActionTd` | Table action columns — buttons right-aligned on one edge (`col-act`). |
| `CellWith` | Table cell with primary label + secondary line (`.cell-sub`). |
| `Kpi` | Metric cards (`.panel.kpi`: label/value+unit/delta). |
| `DetailList` | Label↔value definition rows (model info, node detail). |
| `StatusPill` / `pillClassFor` | Node/deployment/trace states (consistent color mapping). |
| `KeyBlock` | One-time secret reveals (API keys) — terminal surface + copy button. |

## Utility classes (pulse.css)

- **Layout:** `.row` (+`.top`, `.between`), `.wrap`, `.stack` (+`.tight`,
  `.loose`), `.grid.cols-2/.cols-3/.cols-4`, `.spacer`, `.grow`, `.mt`, `.mb`,
  `.col-span-all`, `.toolbar`
- **Widths:** `.w-xs` 76 · `.w-sm` 110 · `.w-md` 170 · `.w-lg` 250 (px);
  `.ctl-sm` for small-height controls
- **Panels:** `.panel` > `.panel-head` (h1/h2/h3 normalized to 13px label;
  `.right` slot) + `.panel-body` (`.flush` for full-bleed tables)
- **Tables:** `.table` / `.dt` (`.num` right-aligned mono cells, `.strong`,
  `.col-act`, `.cell-sub`, `tr.clickable`, `tr.selected`, `.th-spark`)
- **States:** `.pill` (+`.ok/.warn/.crit/.info/.accent`, `.dot`), `.chip`,
  `.callout.*`, `.code-block`, `.key-reveal`, `.empty`>`.empty-action`,
  `.doctor-row`, `.detail-list`, `.meter`>i, `.gauge-row`, `.segmented`,
  `.toast-stack`>`.toast`
- **Text:** `.hint` `.note` `.dim` `.faint` `.tiny` `.small` `.num` `.mono`
- **Buttons:** `.btn` `.primary` `.danger` `.warn` `.ghost` `.sm`, `a.btn`

## Page anatomy (canonical skeleton)

```tsx
<>
  <div className="page-head">
    <div className="page-title"><h1>Title</h1><div className="sub">{derived copy}</div></div>
    <Toolbar>…primary actions…</Toolbar>
  </div>
  {error && <ErrorBanner error={error} />}
  <section className="panel">
    <div className="panel-head"><h2>Section</h2><div className="right">…filters…</div></div>
    <TableScroller>
      <table className="table" data-testid="…">…<ActionTh /></table>
    </TableScroller>
  </section>
</>
```

Grid rows of panels: `<div className="grid cols-N">` (N ≤ 4; panels must fill
the row — no orphans). Spacing between sections comes from `.mt` on the
following element, not margins inside panels.

## Responsive + dark theme

- ≤960px: sidebar off-canvas (☰), grids collapse 4/3→2→1, `.field` stacks
  label-over-control, tables scroll (`TableScroller` handles it),
  `.w-*` controls go full-width.
- Dark: tokens swap under `[data-theme="dark"]`; the topbar ☾ toggle sets +
  persists it. **Every change must be checked in both themes.**

## Mock data (`--fake-fleet`)

`server/src/index.ts` gates all seeding on the `--fake-fleet` flag;
`server/src/mockData.ts` seeds deterministically (fixed PRNG + injected clock):
gateway traces, clients+keys, alerts+events, 7 days of energy history, model
store inventories (via job-argv behavior hooks in `fakeFleet.ts`), recipes,
a deployment, served-model routes, chat demo threads.

Adding a page that needs data: extend `mockData.ts` (idempotent — re-seeding
after restart must not duplicate), never the web app. Tests run the real
stores against temp DBs; unit tests must never observe seed data.

```bash
# develop against the full mock fleet
CC_HOME=/tmp/cc-dev PORT=5599 npx tsx server/src/index.ts --fake-fleet
```

## Review checklist for UI work

- [ ] Runs on primitives; no new inline layout CSS.
- [ ] All controls in a form share height and start column.
- [ ] Tables use `.table` inside `TableScroller`; actions in `col-act`.
- [ ] Empty/loading/error states exist and use `.empty`/`Callout`/`.hint`.
- [ ] Copy is honest for v1 (no milestone talk, no fleet-specific strings).
- [ ] Light **and** dark checked; 390px + 1568px checked.
- [ ] `npx tsc -p web --noEmit`, `npm run test:e2e` green; testids intact.

## Why this shape (decisions)

- **CSS-first, framework-free:** one stylesheet to review; no build/dependency
  churn for a 13-page dashboard; agents restyle consistently because classes
  are discoverable grep targets, while inline styles historically drifted per
  page (the defect class this system removes).
- **Thin JS primitives:** they render canonical markup, so markup-level
  regressions can't recur; logic stays out of them on purpose.
- **Server-side-only mocks:** the UI is proven against the real API surface at
  all times; there is no second data path to forget to remove.
