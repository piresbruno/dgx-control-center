import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  name: string;
  version: string;
  time: string;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Health>;
      })
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>ControlCenter</h1>
      <p>
        {health ? (
          <>
            server ok · v{health.version} · {health.time}
          </>
        ) : error ? (
          <span style={{ color: "#b91c1c" }}>server unreachable: {error}</span>
        ) : (
          "connecting…"
        )}
      </p>
    </main>
  );
}
