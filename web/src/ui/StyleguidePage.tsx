/**
 * Styleguide — dev-facing contract of the Pulse design system.
 * Renders every token, primitive and state in one page so layout
 * regressions are visible without seeding a fleet, and so future
 * contributors (human or agent) have a living reference.
 * Reachable from the sidebar's "Styleguide" entry (dev builds only).
 */
import { useState } from "react";
import {
  Field,
  FormGrid,
  FormRow,
  Toolbar,
  Segmented,
  Callout,
  EmptyState,
  Kpi,
  DetailList,
  StatusPill,
  KeyBlock,
  CellWith,
  ActionTh,
  ActionTd,
} from "./index.js";

const SEV = ["info", "ok", "warn", "crit"] as const;

export function StyleguidePage() {
  const [view, setView] = useState<"table" | "cards">("table");
  const [win, setWin] = useState(24);
  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Styleguide</h1>
          <div className="sub">Pulse design-system contract — tokens, primitives, states. docs/DESIGN_SYSTEM.md.</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Color tokens</h2></div>
        <div className="panel-body">
          <div className="form-row">
            {["bg", "surface", "raised", "overlay", "text-1", "text-2", "text-3", "accent", "ok", "warn", "crit", "info"].map((t) => (
              <span key={t} className="chip">
                <span className="swatch" style={{ background: `var(--${t})` }} />
                --{t}
              </span>
            ))}
          </div>
        </div>
      </section>

      <div className="grid cols-2">
        <section className="panel">
          <div className="panel-head"><h2>Buttons</h2></div>
          <div className="panel-body">
            <Toolbar>
              <button className="btn primary">Primary</button>
              <button className="btn">Default</button>
              <button className="btn warn">Warn</button>
              <button className="btn danger">Danger</button>
              <button className="btn ghost">Ghost</button>
              <button className="btn" disabled>Disabled</button>
              <button className="btn sm">Small</button>
            </Toolbar>
            <div className="hint mt-md">All share the control height scale (--ctl-h / --ctl-h-sm).</div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Form controls</h2></div>
          <div className="panel-body">
            <FormRow>
              <input placeholder="Text input" className="w-lg" />
              <select className="w-md" defaultValue="a"><option value="a">Select (custom chevron)</option><option value="b">Option b</option></select>
              <input type="number" defaultValue={78} className="w-xs" />
.            <label className="row"><input type="checkbox" defaultChecked /> check</label>
            </FormRow>
            <div className="hint mt-md">Styled globally — no class needed. Focus any control for the ring.</div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Aligned form (Field / FormGrid)</h2></div>
        <div className="panel-body">
          <FormGrid>
            <Field label="Rule name" required hint="Shown in alerts and history.">
              <input placeholder="GPU temp guard" />
            </Field>
            <Field label="Condition">
              <FormRow>
                <select defaultValue="node-metric" className="w-md"><option value="node-metric">node metric</option></select>
                <input placeholder="gpu.tempC" className="w-md" />
                <select defaultValue=">=" className="w-xs"><option value=">=">≥</option></select>
                <input type="number" defaultValue={80} className="w-xs" />
                <input type="number" defaultValue={15} className="w-xs" />
                <select defaultValue="warning"><option value="warning">warning</option></select>
                <button className="btn primary">Save rule</button>
              </FormRow>
            </Field>
            <Field label="Notes" top>
              <textarea rows={2} placeholder="free text" />
            </Field>
          </FormGrid>
        </div>
      </section>

      <div className="grid cols-2">
        <section className="panel">
          <div className="panel-head"><h2>Segmented + toolbar</h2></div>
          <div className="panel-body stack">
            <Toolbar>
              <Segmented<"table" | "cards">
                options={[{ value: "table", label: "Table" }, { value: "cards", label: "Cards" }]}
                value={view}
                onChange={setView}
                ariaLabel="View"
              />
              <span className="spacer" />
              <button className="btn sm">Export</button>
            </Toolbar>
            <Segmented<number>
              options={[{ value: 1, label: "1 h" }, { value: 6, label: "6 h" }, { value: 24, label: "24 h" }]}
              value={win}
              onChange={setWin}
              ariaLabel="Window"
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Pills + KPIs</h2></div>
          <div className="panel-body stack">
            <div className="form-row">
              <StatusPill state="consistent" />
              <StatusPill state="degraded" />
              <StatusPill state="offline" />
              <StatusPill state="stopped" />
            </div>
            <div className="grid cols-3">
              <Kpi label="requests" value="1 284" delta="12 errors" />
              <Kpi label="power" value={312} unit="W" delta="fleet total" />
              <Kpi label="TTFT p50" value="412" unit="ms" />
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Callouts</h2></div>
        <div className="panel-body stack tight">
          {SEV.map((k) => <Callout key={k} kind={k}>{k} — message banner (crit renders role=alert)</Callout>)}
        </div>
      </section>

      <div className="grid cols-2">
        <section className="panel">
          <div className="panel-head"><h2>Table (DataTable pattern)</h2></div>
          <div className="panel-body flush">
            <table className="table">
              <thead><tr><th>Client</th><th>Scopes</th><th>ActionTh</th><ActionTh /></tr></thead>
              <tbody>
                <tr>
                  <CellWith title="studio-mac" sub="last seen 2 m ago" />
                  <td><span className="chip">glm-live</span></td>
                  <td className="num">12 480</td>
                  <ActionTd><button className="btn sm">Revoke</button><button className="btn sm ghost">✕</button></ActionTd>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Detail list + key reveal</h2></div>
          <div className="panel-body stack">
            <DetailList items={[{ label: "repository", value: "mlx-community/DeepSeek-R1" }, { label: "size", value: "44.2 GB" }]} />
            <KeyBlock value="cc_live_9f2b7c41d8e05a3b6c1d" testId="sg-key" />
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Empty state</h2></div>
        <div className="panel-body">
          <EmptyState action={<button className="btn sm primary">Add node</button>}>
            No nodes registered yet — add one to start collecting telemetry.
          </EmptyState>
        </div>
      </section>
    </>
  );
}
