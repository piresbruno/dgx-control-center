import type { JobBehavior } from "@cc/shared";
import type { MetricsStore } from "./stores/metricsStore.js";
import type { TracesStore } from "./stores/tracesStore.js";
import type { AlertsStore } from "./stores/alertsStore.js";
import type { ClientsStore } from "./gateway/clients.js";
import type { ServedModelsStore } from "./gateway/servedModels.js";
import type { RecipeStore } from "./serving/recipes.js";
import { parseRecipeProbe, type RecipeProbe } from "./serving/recipes.js";
import type { DeploymentStore } from "./serving/deployments.js";
import { parseServeProbe, rankStates } from "./serving/deployments.js";
import type { ChatStore } from "./chat/store.js";

/**
 * Mock layer for `--fake-fleet` dev mode: canned job outputs (routed by argv,
 * as a real node would produce them) + store seeders, so every dashboard page
 * shows realistic data with zero GPUs. Server-side only — never shipped to
 * `web/`, never touches the production code path.
 */

// ─── Canned node inventories ─────────────────────────────────────────────

/** Store catalog (nas1/dgx1 `modelctl list --json`). */
const STORE_CATALOG = JSON.stringify([
  { name: "GLM-5.3-Flash", repository: "mlab/GLM-5.3-Flash-EXL3", runtime: "exl3", bytes: 68_719_476_736 },
  { name: "GLM-5.3-AWQ", repository: "mlab/GLM-5.3-AWQ-4bit", runtime: "awq", bytes: 40_802_189_312 },
  { name: "Qwen3.6-27B", repository: "mlab/Qwen3.6-27B-GGUF", runtime: "gguf", bytes: 17_309_181_821 },
  { name: "Qwen3-0.6B", repository: "mlab/Qwen3-0.6B-GGUF", runtime: "gguf", bytes: 406_847_232 },
  { name: "DeepSeek-R1-Distill", repository: "mlab/DeepSeek-R1-Distill-Qwen-14B", runtime: "gguf", bytes: 8_986_444_084 },
  { name: "Whisper-large-v3", repository: "mlab/whisper-large-v3-turbo", runtime: "ct2", bytes: 1_620_709_818 },
]);

/** Node-local caches (`modelctl list --local --json`). */
const NODE_LOCAL: Record<string, string> = {
  // dgx1 mounts the NAS store (ADR-0009), so its local view equals the store.
  dgx1: STORE_CATALOG,
  dgx2: JSON.stringify([
    { name: "GLM-5.3-Flash", repository: "mlab/GLM-5.3-Flash-EXL3", runtime: "exl3", bytes: 68_719_476_736 },
    { name: "Qwen3.6-27B", repository: "mlab/Qwen3.6-27B-GGUF", runtime: "gguf", bytes: 17_309_181_821 },
  ]),
  nas1: STORE_CATALOG,
};

// ─── Canned recipe probes (parser-faithful __P_*__ sections) ─────────────

const GLM_RECIPE_PROBE = [
  "__P_FILES__",
  "./start.sh 2048",
  "./start-worker.sh 1024",
  "./status.sh 512",
  "__P_GIT__",
  "a91c4f2e77b04d5f9c3e1a8b6d4f2c0e9a7b5d3f",
  "__P_DIRTY__",
  "__P_DISPATCH__",
  "logs",
  "start",
  "status",
  "stop",
  "__P_ENV__",
  "PORT=8888",
  "MODEL=/models/GLM-5.3-Flash-EXL3",
  "SERVED_MODEL_NAME=glm53-fp8",
  "HEAD_IP=127.0.0.1",
  "WORKER_IP=127.0.0.1",
  "WORKER_USER=piresbruno",
  "NNODES=2",
  "TP=2",
  "MAX_MODEL_LEN=131072",
  "HF_TOKEN=super-secret-token",
  "__P_EXAMPLE__",
  "PORT=8080",
  "MODEL=/models/some-model",
  "__P_CONTAINERS__",
  "./start.sh:CONTAINER_HEAD=glm53-exl3-head",
  "./start-worker.sh:CONTAINER_WORKER=glm53-exl3-worker",
  "__P_END__",
].join("\n");

const QWEN_RECIPE_PROBE = [
  "__P_FILES__",
  "./start.sh 1024",
  "__P_GIT__",
  "3f8b1d6c2a9e4b7f0c5d8e1a3b6c9d2e4f7a0b3c",
  "__P_DIRTY__",
  "__P_DISPATCH__",
  "logs",
  "start",
  "status",
  "stop",
  "__P_ENV__",
  "PORT=8889",
  "MODEL=/models/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf",
  "SERVED_MODEL_NAME=qwen-local",
  "__P_EXAMPLE__",
  "PORT=8090",
  "__P_CONTAINERS__",
  "./start.sh:CONTAINER=cc-qwen",
  "__P_END__",
].join("\n");

/** Recipe probe output per (sparkId, script path). */
function recipeProbeOutput(sparkId: string, script: string): string | null {
  if (sparkId === "dgx1" && script.includes("glm-5.3")) return GLM_RECIPE_PROBE;
  if (sparkId === "dgx2" && script.includes("qwen3")) return QWEN_RECIPE_PROBE;
  return null;
}

// ─── Canned serve probes ─────────────────────────────────────────────────

function serveProbeOutput(sparkId: string): string {
  if (sparkId === "dgx1") {
    return [
      "__S_CONTAINERS__",
      "glm53-exl3-head|running",
      "glm53-exl3-worker|running",
      "cc-nfs-export|running",
      "__S_HEALTH__",
      "200",
      "__S_MODELS__",
      '{"object":"list","data":[{"id":"glm53-fp8","object":"model"}]}',
    ].join("\n");
  }
  return [
    "__S_CONTAINERS__",
    "cc-qwen|running",
    "__S_HEALTH__",
    "200",
    "__S_MODELS__",
    '{"object":"list","data":[{"id":"qwen-local","object":"model"}]}',
  ].join("\n");
}

/** Clock status probe stdout (parseClockStatus sections). */
function clockStatusOutput(sparkId: string): string[] {
  const gpu = sparkId === "dgx1" ? "1800, 1800, 2100, 1402" : "1650, 1650, 2100, 1005";
  return [
    "__C_GPU__",
    gpu,
    "__C_CPU__",
    "2600000",
    "__C_HWM__",
    "1000000",
    "__C_HWX__",
    "2600000",
    "__C_HELPER__",
    sparkId === "dgx1" ? "yes" : "no",
    "__C_END__",
  ];
}

/** Fabric probe stdout (__F_* sections); the NAS has no mlx5 links. */
function fabricOutput(sparkId: string): string[] {
  if (sparkId === "nas1") return ["__F_IFACES__", "__F_ERRORS__", "__F_END__"];
  return [
    "__F_IFACES__",
    "eth0 200000 up",
    "__F_ERRORS__",
    "eth0 rx_crc_errors 0",
    "eth0 rx_symbol_error 0",
    "eth0 roce_adp_retrans 0",
    "eth0 np_cnp_sent 41",
    "__F_END__",
  ];
}

// ─── Job behavior router ─────────────────────────────────────────────────

/**
 * Argv-keyed fake job behavior for the --fake-fleet node WS. Null ⇒ fall
 * through to FakeNode's generic placeholder (unit-test expectations).
 * Keyed by argv CONTENT, never by reqId (jobs are dispatched at click time).
 */
export function fakeJobBehavior(sparkId: string, argv: string[]): JobBehavior | null {
  const joined = argv.join(" ");

  if (joined === "modelctl list --json") return { exitCode: 0, output: [STORE_CATALOG] };
  if (joined === "modelctl list --local --json") return { exitCode: 0, output: [NODE_LOCAL[sparkId] ?? "[]"] };
  if (joined === "modelctl --version") return { exitCode: 0, output: ["modelctl 0.5.2"] };
  if (joined === "uv --version") return { exitCode: 0, output: ["uv 0.7.19"] };

  if (argv[0] === "bash" && argv[1] === "-c") {
    const script = argv.slice(2).join(" ");
    // Recipe folder probe (Serve page "Probe"): canned __P_* sections.
    if (script.includes("__P_FILES__")) {
      const out = recipeProbeOutput(sparkId, script);
      if (out) return { exitCode: 0, output: out.split("\n") };
      return { exitCode: 0, output: ["__P_NOPATH__"] };
    }
    // Deployment probe: containers / health / models for the node's engine.
    if (script.includes("__S_CONTAINERS__")) return { exitCode: 0, output: serveProbeOutput(sparkId).split("\n") };
    // Clock status: its script contains nvidia-smi AND the cc-clock path, so
    // match its own marker before the generic branches below.
    if (script.includes("__C_GPU__")) return { exitCode: 0, output: clockStatusOutput(sparkId) };
    // Clock installer: succeed with the ok marker parseInstallMarker looks for.
    if (script.includes("__CLOCK_INSTALL__")) return { exitCode: 0, output: ["__CLOCK_INSTALL__:ok"] };
    // Fabric probe (buildFabricProbeCommand → __F_* sections).
    if (script.includes("__F_IFACES__")) return { exitCode: 0, output: fabricOutput(sparkId) };
    // Capability sweep (python harness prints one JSON object; it also
    // mentions cc-clock, so match its ccClock key BEFORE the apply branch).
    if (script.includes("ccClock")) {
      const sweep = {
        node: "Linux 6.11.0-aarch64 (fake)",
        nodejs: "v22.14.0",
        modelctl: "modelctl 0.5.2",
        uv: "uv 0.7.19",
        docker: "Docker version 27.5.1, build 9f9e4ff",
        ccClock: sparkId === "dgx1" ? "installed" : "missing",
      };
      return { exitCode: 0, output: [JSON.stringify(sweep)] };
    }
    // clock-apply (buildApplyScript → sudo -n cc-clock …): succeeds silently.
    if (script.includes("cc-clock")) return { exitCode: 0, output: ["[fake] clocks applied"] };
    // Bench harness (python stdlib → one JSON record per iteration). The cfg
    // is double JSON-escaped into the script, hence the backslash quotes.
    if (script.includes("urllib.request")) {
      const iterations = Math.min(20, Number(script.match(/iterations\\":(\d+)/)?.[1] ?? 5) || 5);
      const maxTokens = Number(script.match(/max_tokens\\":(\d+)/)?.[1] ?? 128) || 128;
      const promptTokens = sparkId === "dgx1" ? 612 : 47;
      const lines: string[] = [];
      for (let k = 1; k <= iterations; k++) {
        lines.push(JSON.stringify({ i: k, durationMs: 380 + ((k * 97) % 210), completionTokens: maxTokens, promptTokens }));
      }
      return { exitCode: 0, output: lines };
    }
  }
  return null;
}

// ─── Seeders ─────────────────────────────────────────────────────────────

export interface SeedDeps {
  metrics: MetricsStore;
  traces: TracesStore;
  alerts: AlertsStore;
  clients: ClientsStore;
  servedModels: ServedModelsStore;
  recipes: RecipeStore;
  deployments: DeploymentStore;
  chat: ChatStore;
  now?: () => number;
}

/** ~40 gateway traces spread over the last 24 h, mostly healthy. */
function seedTraces(deps: SeedDeps, now: number): void {
  if (deps.traces.list({}).length > 0) return;
  const clients = ["claude-code", "aider", "openclaw", "bench-runner"];
  const h = 3_600_000;
  for (let i = 0; i < 40; i++) {
    const ts = now - Math.floor((i / 40) * 24 * h + Math.sin(i * 2.7) * 900_000);
    const alias = i % 5 === 4 ? "qwen-local" : "glm-live";
    const stream = i % 3 !== 0;
    const failed = i === 7 || i === 23 || i === 31;
    const prompt = 400 + ((i * 137) % 2600);
    const completion = failed ? 0 : 80 + ((i * 71) % 900);
    const port = alias === "glm-live" ? 8888 : 8889;
    const slowTail = i === 4 || i === 12; // a couple of cold-cache first tokens
    deps.traces.insert({
      ts,
      client: clients[i % clients.length]!,
      alias,
      model: alias,
      nodeId: alias === "glm-live" ? "dgx1" : "dgx2",
      port,
      status: failed ? 502 : i === 15 ? 429 : 200,
      ttftMs: failed ? null : slowTail ? 2100 + i * 60 : 180 + ((i * 53) % 600),
      durationMs: failed ? 40 + (i % 30) : 900 + ((i * 211) % 9000),
      stream,
      promptTokens: prompt,
      completionTokens: completion,
      itl: Array.from({ length: Math.min(12, Math.max(1, completion)) }, (_, k) => 20 + ((k + i) % 15)),
      attempts: failed
        ? [
            { nodeId: "dgx1", port: 8888, status: null, error: "ECONNRESET" },
            { nodeId: "dgx2", port: 8889, status: 502 },
          ]
        : [{ nodeId: alias === "glm-live" ? "dgx1" : "dgx2", port, status: 200 }],
      error: failed ? "upstream reset (502)" : null,
    });
  }
}

function seedClients(deps: SeedDeps): void {
  if (deps.clients.list().length > 0) return;
  const made: Array<{ clientId: string; key: string }> = [];
  for (const name of ["claude-code", "aider", "openclaw", "bench-runner"]) {
    const { client, key } = deps.clients.create({ name, scopes: name === "bench-runner" ? ["qwen-local"] : undefined });
    made.push({ clientId: client.id, key });
  }
  deps.clients.revoke(made[3]!.clientId);
  // verify() bumps lastSeenAt — two clients show as "recently used".
  deps.clients.verify(made[0]!.key);
  deps.clients.verify(made[1]!.key);
}

function seedServedModels(deps: SeedDeps): void {
  if (!deps.servedModels.byAlias("glm-live")) {
    deps.servedModels.upsert({
      alias: "glm-live",
      targets: [
        { nodeId: "dgx1", port: 8888 },
        { nodeId: "dgx2", port: 8889 },
      ],
      // Flagship alias supports image attachments in the chat page picker.
      vision: true,
    });
  }
  if (!deps.servedModels.byAlias("qwen-local")) {
    deps.servedModels.upsert({ alias: "qwen-local", targets: [{ nodeId: "dgx2", port: 8889 }], vision: false });
  }
}

function seedRecipes(deps: SeedDeps, now: number): void {
  const glm = deps.recipes.register({ sparkId: "dgx1", path: "/srv/recipes/glm-5.3", label: "GLM 5.3 (exl3 TP=2)" });
  const glmProbe: RecipeProbe = parseRecipeProbe(GLM_RECIPE_PROBE, () => now);
  deps.recipes.updateFromProbe(glm.recipe.id, glmProbe, "./start.sh");
  const qwen = deps.recipes.register({ sparkId: "dgx2", path: "/srv/recipes/qwen3", label: "Qwen3 0.6B llama.cpp" });
  const qwenProbe: RecipeProbe = parseRecipeProbe(QWEN_RECIPE_PROBE, () => now);
  deps.recipes.updateFromProbe(qwen.recipe.id, qwenProbe, "./start.sh");
  // lastProbe mirrors exactly what the serve-probe job returns, with ranks +
  // parsedAt, so manual probes on the Serve page stay coherent.
  const glmServe = parseServeProbe(serveProbeOutput("dgx1"));
  deps.deployments.upsertForRecipe(
    glm.recipe.id,
    { sparkId: "dgx1", entry: "./start.sh", port: 8888, servedName: "glm53-fp8" },
    {
      desired: "running",
      startedWith: { gitHead: glmProbe.versions?.gitHead ?? null, dirtyBuild: false },
      lastProbe: { ...glmServe, ranks: rankStates(glmProbe.meta?.containers ?? {}, glmServe), parsedAt: now },
    },
  );
  const qwenServe = parseServeProbe(serveProbeOutput("dgx2"));
  deps.deployments.upsertForRecipe(
    qwen.recipe.id,
    { sparkId: "dgx2", entry: "./start.sh", port: 8889, servedName: "qwen-local" },
    {
      desired: "running",
      startedWith: { gitHead: qwenProbe.versions?.gitHead ?? null, dirtyBuild: false },
      lastProbe: { ...qwenServe, ranks: rankStates(qwenProbe.meta?.containers ?? {}, qwenServe), parsedAt: now },
    },
  );
}

/**
 * Firing critical + resolved warning on real seed rules whose rows the 60 s
 * alert engine never closes: `seed-node-down` on dgx3 (NOT in the directory →
 * never sampled → stays open forever) and a resolved `seed-gpu-temp` on dgx2
 * (resolved rows are terminal).
 */
function seedAlerts(deps: SeedDeps, now: number): void {
  if (!deps.alerts.openByRuleEntity("seed-node-down", "dgx3")) {
    deps.alerts.insert({
      ruleId: "seed-node-down",
      ruleName: "Node unreachable",
      severity: "critical",
      entity: "dgx3",
      detail: "no agent connection for 45 min (3 consecutive ping misses)",
      state: "firing",
      firedAt: now - 45 * 60_000,
    });
  }
  const resolved = deps.alerts
    .list({ state: "resolved" })
    .some((a) => a.ruleId === "seed-gpu-temp" && a.entity === "dgx2");
  if (!resolved) {
    const a = deps.alerts.insert({
      ruleId: "seed-gpu-temp",
      ruleName: "GPU temperature high",
      severity: "warning",
      entity: "dgx2",
      detail: "gpu.tempC ≥ 78 for 15 min (peak 81 °C)",
      state: "firing",
      firedAt: now - 6 * 3_600_000,
    });
    deps.alerts.acknowledge(a.id, "bruno");
    deps.alerts.resolve(a.id, "load moved to dgx1; temps back under 78 °C", true);
  }
}

function seedChat(deps: SeedDeps): void {
  if (deps.chat.listConversations().length > 0) return;
  const folder = deps.chat.createFolder({
    name: "Home infranet",
    description: "Answer questions about the local DGX cluster: 2× GB10 sparks (dgx1 head, dgx2 worker) + a NAS model store.",
  });
  const conv = deps.chat.createConversation({ folderId: folder.id, model: "glm-live", title: "Cluster sizing" });
  deps.chat.appendMessage({
    conversationId: conv.id,
    role: "user",
    content: "How much unified memory does the GLM TP=2 deployment need?",
  });
  deps.chat.appendMessage({
    conversationId: conv.id,
    role: "assistant",
    content:
      "The **GLM-5.3-Flash** recipe runs `TP=2` across dgx1 + dgx2:\n\n- weights: ~64 GiB (EXL3, 4.0 bpw)\n- KV cache at 131 k ctx: ~18 GiB total\n- headroom: keep each node under ~85 % of 128 GiB\n\nSo budget roughly **85–95 GiB aggregate**.\n\n| item | state |\n|---|---|\n| head | running |\n| worker | running |\n",
    usage: { promptTokens: 212, completionTokens: 188 },
    ttftMs: 341,
    durationMs: 4210,
  });
  deps.chat.appendMessage({
    conversationId: conv.id,
    role: "user",
    content: "And for a quick local test model?",
  });
  deps.chat.appendMessage({
    conversationId: conv.id,
    role: "assistant",
    content:
      "Use `Qwen3-0.6B` — ~0.4 GiB, llama.cpp on dgx2, alias `qwen-local`. It boots in under a second:\n\n```bash\ncurl http://dgx2:8889/v1/models\n```",
    usage: { promptTokens: 340, completionTokens: 96 },
    ttftMs: 289,
    durationMs: 2450,
  });
}

/** 7 days − 2 h of per-minute power history for the energy pages. */
function seedEnergy(deps: SeedDeps, now: number): void {
  const minute = 60_000;
  const totalMinutes = 7 * 24 * 60 - 120;
  const base = now - totalMinutes * minute;
  const nodes: Array<[string, number]> = [
    ["dgx1", 170],
    ["dgx2", 140],
  ];
  const CHUNK = 720; // flush per half-day to bound the buffer
  // Idempotent: the 1m rows already exist after a first seed — re-walking ~14k
  // minutes would double-merge the 1h/1d rollups for nothing.
  if (deps.metrics.query("gpu", { from: base, to: now, granularity: "1m" }).length > 0) return;
  for (let i = 0; i < totalMinutes; i++) {
    const ts = base + i * minute;
    const d = new Date(ts);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    // diurnal load: idle nights, work-day peak ~16:00
    const day = 0.25 + 0.65 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2) ** 2);
    const wiggle = 0.9 + ((i * 37) % 13) / 60; // deterministic wobble
    for (const [nodeId, idleW] of nodes) {
      const load = nodeId === "dgx1" ? day : day * 0.8;
      const watts = Math.round(idleW + load * 210 * wiggle);
      const utilPct = Math.round(load * 90);
      const tempC = Math.min(76, 52 + Math.round(load * 24)); // ≤76: thermal guard (≥78) must never fire
      deps.metrics.ingest(nodeId, {
        ts,
        domains: {
          gpu: {
            utilPct,
            tempC,
            // Real agents report per-GPU fields under gpus.<idx> (agent/src/
            // collectors.ts); the fleet explorer leaves read gpus.0.*.
            gpus: { "0": { utilPct, tempC, watts, clockMhz: Math.round(1200 + load * 900) } },
          },
        },
      });
    }
    if (i % CHUNK === CHUNK - 1) deps.metrics.flush();
  }
  deps.metrics.flush();
}

/** Seed everything; idempotent where the stores are reused across restarts. */
export function seedMockData(deps: SeedDeps): void {
  const now = (deps.now ?? Date.now)();
  seedEnergy(deps, now);
  seedTraces(deps, now);
  seedClients(deps);
  seedServedModels(deps);
  seedRecipes(deps, now);
  seedAlerts(deps, now);
  seedChat(deps);
}
