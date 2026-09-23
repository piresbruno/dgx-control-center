import { useEffect, useRef, useState } from "react";

/**
 * Live snapshot hook (F1a): connects to /ws, keeps the latest snapshot plus a
 * bounded per-node metric history ring for sparklines. Reconnects with 2 s
 * delay; reports connection state for the topbar dot.
 */

export interface LiveNode {
  sparkId: string;
  name: string;
  kind: string;
  role: string;
  state: string;
  domains: Record<string, Record<string, unknown>>;
  lastMetricsTs: number | null;
}

export interface LiveSnapshot {
  version: number;
  nodes: LiveNode[];
}

const RING_SIZE = 60;

export interface UseLiveSnapshot {
  nodes: LiveNode[];
  history: Record<string, Record<string, number[]>>;
  connected: boolean;
}

export function useLiveSnapshot(wsUrl = wsUrlFromLocation()): UseLiveSnapshot {
  const [nodes, setNodes] = useState<LiveNode[]>([]);
  const [connected, setConnected] = useState(false);
  const historyRef = useRef<Record<string, Record<string, number[]>>>({});
  const [, forceTick] = useState(0);

  useEffect(() => {
    let closedByUs = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        setConnected(true);
        retry = null;
      };
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data as string) as LiveSnapshot & { type: string };
        if (frame.type !== "snapshot") return;
        setNodes(frame.nodes);
        for (const node of frame.nodes) {
          const ring = (historyRef.current[node.sparkId] ??= {});
          for (const [domain, data] of Object.entries(node.domains ?? {})) {
            const series = (ring[domain] ??= []);
            const last = series[series.length - 1];
            series.push(extractPrimary(domain, data, last));
            if (series.length > RING_SIZE) series.shift();
          }
        }
        forceTick((n) => n + 1);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closedByUs) retry = setTimeout(connect, 2_000);
      };
    };
    connect();

    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [wsUrl]);

  return { nodes, history: historyRef.current, connected };
}

/** One representative number per domain for the client-side sparkline ring. */
function extractPrimary(domain: string, data: Record<string, unknown>, last: number | undefined): number {
  const numeric = Object.values(data).filter((v): v is number => typeof v === "number");
  if (numeric.length > 0) return numeric[0]!;
  if (last !== undefined) return last;
  return 0;
}

function wsUrlFromLocation(): string {
  const proto = globalThis.location?.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${globalThis.location?.host ?? "localhost:5555"}/ws`;
}
