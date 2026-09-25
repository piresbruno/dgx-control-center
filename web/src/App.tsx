import { useEffect, useState, type ReactElement } from "react";
import { useLiveSnapshot, type LiveNode } from "./api/ws.js";
import { apiGet } from "./api/client.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { NodePage } from "./pages/NodePage.js";
import { ModelsPage } from "./pages/ModelsPage.js";
import { ServePage } from "./pages/ServePage.js";
import { RecipesPage } from "./pages/RecipesPage.js";
import { AnalysisPage } from "./pages/AnalysisPage.js";
import { ClientsPage } from "./pages/ClientsPage.js";
import { RouterPage } from "./pages/RouterPage.js";
import { EnergyPage } from "./pages/PowerPage.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { FleetExplorerPage } from "./pages/FleetExplorerPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { StyleguidePage } from "./ui/StyleguidePage.js";

type PageId = "overview" | "chat" | "node" | "models" | "serve" | "recipes" | "analysis" | "clients" | "router" | "energy" | "alerts" | "fleet" | "settings" | "styleguide";

const NAV: Array<{ sec?: string; id?: PageId; label?: string }> = [
  { sec: "Fleet" },
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
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
  { id: "alerts", label: "Alerts" },
  { id: "fleet", label: "Fleet explorer" },
  { sec: "System" },
  { id: "settings", label: "Settings" },
  ...(import.meta.env.DEV ? [{ id: "styleguide" as const, label: "Styleguide" }] : []),
];

/** Topbar breadcrumb labels — page id alone reads poorly ("FleetExplorer"). */
const LABELS: Record<PageId, string> = {
  overview: "Overview", chat: "Chat", node: "Nodes", models: "Models", serve: "Serve",
  recipes: "Recipes", analysis: "Analysis", clients: "Clients", router: "Router",
  energy: "Energy", alerts: "Alerts", fleet: "Fleet explorer", settings: "Settings",
  styleguide: "Styleguide",
};

export function App() {
  const { nodes, history, connected, alerts, dismissAlert } = useLiveSnapshot();
  const [page, setPage] = useState<PageId>("overview");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<"" | "dark">(
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "",
  );
  const [envLabel, setEnvLabel] = useState("");

  // Sidebar env line: registered-node count from the directory, never hardcoded.
  useEffect(() => {
    let alive = true;
    apiGet<{ nodes: unknown[] }>("/api/nodes")
      .then((d) => {
        if (!alive) return;
        const count = d.nodes?.length ?? 0;
        setEnvLabel(`${count} node${count === 1 ? "" : "s"} · ${window.location.host}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Theme: dark tokens existed in pulse.css but were unreachable — apply to
  // <html data-theme> and persist the choice.
  useEffect(() => {
    if (localStorage.getItem("cc-theme") === "dark") setTheme("dark");
  }, []);
  useEffect(() => {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("cc-theme", theme === "dark" ? "dark" : "light");
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "" : "dark"));

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
      {alerts.length > 0 && (
        <div className="toast-stack" data-testid="alert-toasts">
          {alerts.map((a) => (
            <div
              key={a.id}
              className={`panel toast ${a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "info"}`}
            >
              <div className="panel-body row top">
                <span className={`pill ${a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "info"}`}>
                  <span className="dot" />{a.severity}
                </span>
                <div className="grow">
                  <strong>{a.ruleName}</strong>
                  <div className="cell-sub">{a.entity} — {a.detail}</div>
                </div>
                <button className="btn sm ghost" aria-label="Dismiss" onClick={() => dismissAlert(a.id)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <aside className={navOpen ? "sidebar open" : "sidebar"} data-testid="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" /></svg>
          </div>
          <div>
            <b>ControlCenter</b>
            <span className="env">{envLabel || "connecting…"}</span>
          </div>
        </div>
        {NAV.map((item) =>
          item.sec ? (
            <div className="nav-sec" key={item.sec}>{item.sec}</div>
          ) : (
            <button
              key={item.id}
              className={page === item.id ? "nav-item active" : "nav-item"}
              data-testid={`nav-${item.id}`}
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
            {page === "node" && node ? <>Nodes <span>·</span> <b>{node.name}</b></> : <b>{LABELS[page]}</b>}
          </div>
          <div className="spacer" />
          <span className={connected ? "live-dot" : "live-dot off"} title={connected ? "live" : "disconnected"} />
          <button className="btn ghost sm" onClick={toggleTheme} aria-label="Toggle theme" data-testid="theme-toggle">
            {theme === "dark" ? "☀" : "☾"}
          </button>
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
          {page === "chat" && <ChatPage />}
          {page === "alerts" && <AlertsPage />}
          {page === "fleet" && <FleetExplorerPage />}
          {page === "settings" && <SettingsPage />}
          {page === "styleguide" && <StyleguidePage />}
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
