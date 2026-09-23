import { useState, type ReactElement } from "react";
import { useLiveSnapshot, type LiveNode } from "./api/ws.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { NodePage } from "./pages/NodePage.js";
import { ModelsPage } from "./pages/ModelsPage.js";
import { ServePage } from "./pages/ServePage.js";
import { RecipesPage } from "./pages/RecipesPage.js";
import { AnalysisPage } from "./pages/AnalysisPage.js";
import { ClientsPage } from "./pages/ClientsPage.js";
import { RouterPage } from "./pages/RouterPage.js";
import { EnergyPage } from "./pages/PowerPage.js";

type PageId = "overview" | "node" | "models" | "serve" | "recipes" | "analysis" | "clients" | "router" | "energy" | "alerts" | "settings";

const NAV: Array<{ sec?: string; id?: PageId; label?: string }> = [
  { sec: "Fleet" },
  { id: "overview", label: "Overview" },
  { id: "node", label: "Nodes" },
  { sec: "Model Plane" },
  { id: "models", label: "Models" },
  { sec: "Serving" },
  { id: "recipes", label: "Recipes" },
  { id: "serve", label: "Serve" },
  { sec: "Gateway" },
  { id: "router", label: "Router" },
  { id: "clients", label: "Clients" },
  { id: "analysis", label: "Analysis" },
  { id: "energy", label: "Energy" },
  { sec: "Coming in later milestones" },
  { id: "alerts", label: "Alerts" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const { nodes, history, connected } = useLiveSnapshot();
  const [page, setPage] = useState<PageId>("overview");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<"" | "dark">(
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "",
  );

  const selectNode = (id: string) => {
    setSelectedNode(id);
    setPage("node");
    setNavOpen(false);
  };

  const navigate = (id: PageId) => {
    setPage(id);
    setNavOpen(false);
  };

  const node = nodes.find((n) => n.sparkId === selectedNode) ?? null;

  return (
    <div className="app">
      <aside className={navOpen ? "sidebar open" : "sidebar"} data-testid="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" /></svg>
          </div>
          <div>
            <b>ControlCenter</b>
            <span className="env">home.local</span>
          </div>
        </div>
        {NAV.map((item) =>
          item.sec ? (
            <div className="nav-sec" key={item.sec}>{item.sec}</div>
          ) : (
            <button
              key={item.id}
              className={page === item.id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(item.id!)}
            >
              {item.label}
            </button>
          ),
        )}
        <div className="foot tiny faint">signed in as admin</div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="btn ghost sm menu-btn" aria-label="Menu" onClick={() => setNavOpen(!navOpen)}>☰</button>
          <div className="crumb">
            {page === "node" && node ? <>Nodes <span>·</span> <b>{node.name}</b></> : <b>{page.charAt(0).toUpperCase() + page.slice(1)}</b>}
          </div>
          <div className="spacer" />
          <span className={connected ? "live-dot" : "live-dot off"} title={connected ? "live" : "disconnected"} />
        </div>

        <div className="page">
          {page === "overview" && (
            <OverviewPage nodes={nodes} history={history} connected={connected} onSelectNode={selectNode} />
          )}
          {page === "node" && (
            <NodePage node={node} nodes={nodes} history={history} onSelectNode={selectNode} />
          )}
          {page === "models" && <ModelsPage />}
          {page === "recipes" && <RecipesPage />}
          {page === "serve" && <ServePage />}
          {page === "analysis" && <AnalysisPage />}
          {page === "clients" && <ClientsPage />}
          {page === "router" && <RouterPage />}
          {page === "energy" && <EnergyPage />}
          {page === "alerts" && (
            <div className="panel"><div className="panel-body"><div className="empty">Alerts ship at M6 — see PLAN.md F5a.</div></div></div>
          )}
          {page === "settings" && (
            <div className="panel"><div className="panel-body"><div className="empty">Settings land across M4–M7.</div></div></div>
          )}
        </div>
      </div>
    </div>
  );
}

export function statusPill(state: string): ReactElement {
  const kind =
    state === "consistent" ? "ok" : state === "drifted" || state === "degraded" ? "warn" : state === "offline" ? "crit" : "info";
  return (
    <span className={`pill ${kind}`}>
      <span className="dot" />
      {state}
    </span>
  );
}

export function nodeSummary(node: LiveNode): string {
  const gpu = node.domains["gpu"] as Record<string, unknown> | undefined;
  const watts = node.domains["power"] as Record<string, unknown> | undefined;
  const parts: string[] = [];
  const util = typeof gpu?.["utilPct"] === "number" ? gpu["utilPct"] : null;
  if (util !== null) parts.push(`${util} % GPU`);
  const w = typeof watts?.["watts"] === "number" ? watts["watts"] : null;
  if (w !== null) parts.push(`${w} W`);
  return parts.join(" · ") || "idle";
}
