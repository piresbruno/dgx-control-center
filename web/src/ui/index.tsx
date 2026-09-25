/**
 * Pulse design-system primitives — the ONLY components pages should use for
 * forms, toolbars, tables, banners and empty states. Styling lives in
 * ../styles/pulse.css; these render the canonical class names so layout
 * stays consistent and there is one place to change it.
 *
 * Hard rules (see docs/DESIGN_SYSTEM.md):
 *  - Never inline color/margin/width; use these + the utility classes.
 *  - Form controls are styled globally by pulse.css — no className needed.
 *  - Every page reads data through ../api/*; mocks only via --fake-fleet.
 */
import type { ReactNode } from "react";

/* ── Forms ──────────────────────────────────────────────────────────────── */

/** Label + control row inside a .form-grid — label column aligns across rows. */
export function Field({
  label,
  htmlFor,
  required,
  hint,
  top,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  top?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={top ? "field top" : "field"}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      <div className="stack tight grow">
        {children}
        {hint && <div className="hint">{hint}</div>}
      </div>
    </div>
  );
}

/** A column of Field rows with aligned labels. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

/** Free-flowing control row (filters, dense toolbars). */
export function FormRow({ children }: { children: ReactNode }) {
  return <div className="form-row">{children}</div>;
}

/* ── Toolbars + segmented toggles ───────────────────────────────────────── */

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
}

/** A mutually-exclusive button group (filters, buckets, views). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  testId,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(next: T): void;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel} data-testid={testId}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? "active" : ""}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Banners ────────────────────────────────────────────────────────────── */

export type CalloutKind = "info" | "ok" | "warn" | "crit";

/** Inline message / error / success banner. Use for every non-table message. */
export function Callout({ kind, children, testId }: { kind: CalloutKind; children: ReactNode; testId?: string }) {
  return (
    <div className={`callout ${kind}`} role={kind === "crit" ? "alert" : "status"} data-testid={testId}>
      <span>{children}</span>
    </div>
  );
}

/** Error banner helper — renders nothing when there is no error. */
export function ErrorBanner({ error, testId }: { error: string | null; testId?: string }) {
  if (!error) return null;
  return <Callout kind="crit" testId={testId}>{error}</Callout>;
}

/* ── Empty states ───────────────────────────────────────────────────────── */

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div>{children}</div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/* ── Tables ─────────────────────────────────────────────────────────────── */

/** Panel body wrapper that scrolls a wide table on small screens. */
export function TableScroller({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  return (
    <div className="panel-body flush" style={maxHeight ? { overflowX: "auto", maxHeight } : { overflowX: "auto" }}>
      {children}
    </div>
  );
}

/** Header cell for the right-aligned action column. */
export function ActionTh({ label = "Actions" }: { label?: string }) {
  return <th className="col-act">{label}</th>;
}

/** Row of action buttons for the .col-act cell (right-aligned, single edge). */
export function ActionTd({ children }: { children: ReactNode }) {
  return <td className="col-act">{children}</td>;
}

/** Primary label + optional secondary line inside a table cell. */
export function CellWith({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <td>
      <span className="strong">{title}</span>
      {sub && <div className="cell-sub">{sub}</div>}
    </td>
  );
}

/* ── KPI cards ────────────────────────────────────────────────────────── */

export function Kpi({ label, value, unit, delta, testId }: { label: ReactNode; value: ReactNode; unit?: ReactNode; delta?: ReactNode; testId?: string }) {
  return (
    <div className="panel kpi" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {delta && <div className="delta dim">{delta}</div>}
    </div>
  );
}

/* ── Detail list (label / value rows) ─────────────────────────────────── */

export function DetailList({ items }: { items: Array<{ label: ReactNode; value: ReactNode; mono?: boolean }> }) {
  return (
    <dl className="detail-list">
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd className={it.mono === false ? undefined : "mono"}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Status pill ──────────────────────────────────────────────────────── */

export function pillClassFor(state: string): string {
  if (state === "consistent" || state === "healthy" || state === "running" || state === "done" || state === "nominal") return "pill ok";
  if (state === "drifted" || state === "degraded" || state === "starting" || state === "down" || state === "failed") return "pill warn";
  if (state === "offline" || state === "crit" || state === "unreachable") return "pill crit";
  return "pill info";
}

export function StatusPill({ state }: { state: string }) {
  return (
    <span className={pillClassFor(state)}>
      <span className="dot" />
      {state}
    </span>
  );
}

/* ── One-time secret reveal (API keys) ────────────────────────────────── */

export function KeyBlock({ value, testId }: { value: string; testId?: string }) {
  return (
    <div className="key-reveal" data-testid={testId}>
      <span className="key-reveal-value">{value}</span>
      <button
        className="btn sm"
        onClick={() => void navigator.clipboard?.writeText(value).catch(() => undefined)}
      >
        Copy
      </button>
    </div>
  );
}
