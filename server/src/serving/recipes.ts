import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { shellQuote } from "../util/shellQuote.js";

/**
 * Recipe registry (M3, ADR-0005: recipes stay user-owned).
 *
 * A recipe is an opaque, self-orchestrating FOLDER on a node (typically a git
 * clone): start.sh dispatcher with start|stop|restart|status|logs verbs,
 * `.env` parameters, multinode logic internal to the recipe. The dashboard
 * NEVER edits recipe content — it registers the folder, probes it read-only
 * (one exec via the agent job channel), and runs its verbs as jobs.
 *
 * Secrets never leave the node: .env values for keys ending in KEY, TOKEN,
 * SECRET or PASSWORD are reduced to presence booleans.
 */

const RECIPE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PROBE_LIMIT = 24_000;

export function validRecipeId(id: string): boolean {
  return typeof id === "string" && RECIPE_ID_RE.test(id);
}

/** Absolute node path, traversal-tolerant (it IS an absolute node path). */
export function validRecipePath(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\0") && p.startsWith("/");
}

export function recipeKey(sparkId: string, p: string): string {
  const norm = path.posix.normalize(p).replace(/\/+$/, "") || "/";
  return `${sparkId}\u0000${norm}`;
}

export function makeRecipeId(sparkId: string, p: string): string {
  const base =
    path.posix
      .basename(p)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 40) || "recipe";
  const hash = crypto.createHash("sha1").update(recipeKey(sparkId, p)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

// ─── Probe (pure builder / parsers) ─────────────────────────

/**
 * ONE-exec read-only probe for a recipe folder. Bounded outputs everywhere;
 * the folder path is shell-quoted server-side.
 */
export function buildRecipeProbeCommand(absPath: string): string {
  const q = shellQuote(absPath);
  return [
    `cd ${q} || { echo "__P_NOPATH__"; exit 0; }`,
    "echo __P_FILES__",
    "find . -maxdepth 2 -type f -name '*.sh' -printf '%p %s\\n' 2>/dev/null | sort | head -40",
    "echo __P_GIT__",
    "git rev-parse HEAD 2>/dev/null || true",
    "echo __P_DIRTY__",
    "git status --porcelain -- Dockerfile overlay 2>/dev/null | head -20",
    "echo __P_DISPATCH__",
    "grep -oE '^ *(start|stop|status|logs|restart|download)\\)' start.sh 2>/dev/null | tr -d ' )' | sort -u | head",
    "echo __P_ENV__",
    `head -c ${PROBE_LIMIT} .env 2>/dev/null || true`,
    "echo __P_EXAMPLE__",
    `head -c ${PROBE_LIMIT} .env.example 2>/dev/null || true`,
    "echo __P_CONTAINERS__",
    "grep -HE 'CONTAINER[A-Z0-9_]*=' start.sh start-*.sh tp*/start*.sh 2>/dev/null | head -48",
    "echo __P_END__",
  ].join("\n");
}

export function parseProbeOutput(out: string): { noPath?: boolean; sections: Record<string, string[]> } {
  const text = String(out ?? "");
  if (text.includes("__P_NOPATH__")) return { noPath: true, sections: {} };
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^__P_([A-Z]+)__/);
    if (m) {
      cur = m[1]!.toLowerCase();
      sections[cur] = [];
      const rest = line.replace(/^__P_[A-Z]+__/, "").trim();
      if (rest && cur !== "end") sections[cur]!.push(rest);
      continue;
    }
    if (cur && cur !== "end") sections[cur]!.push(line);
  }
  return { sections };
}

const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
const PUBLIC_KEYS = new Set([
  "PORT",
  "MODEL",
  "MODEL_FALLBACK",
  "DFLASH_MODEL",
  "SERVED_MODEL_NAME",
  "HEAD_IP",
  "WORKER_IP",
  "WORKER_USER",
  "NNODES",
  "TP",
  "READY_TIMEOUT",
  "MAX_MODEL_LEN",
  "GPU_MEM_UTIL",
  "IMAGE",
]);

export interface ParsedEnv {
  vars: Record<string, string>;
  secrets: Record<string, boolean>;
}

/** Parse KEY=VALUE text; secret keys → presence only. Last assignment wins. */
export function parseEnvText(text: string): ParsedEnv {
  const vars: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (!val.startsWith("#") && val.includes(" #")) val = val.split(" #")[0]!.trim();
    if (SECRET_KEY_RE.test(key)) {
      if (val !== "") secrets[key] = true;
      continue;
    }
    if (PUBLIC_KEYS.has(key)) vars[key] = val;
  }
  return { vars, secrets };
}

/** Per-entry container-name defaults scraped from grep -H lines. */
export function parseContainerLines(lines: string[]): Record<string, Record<string, string>> {
  const byEntry: Record<string, Record<string, string>> = {};
  for (const raw of lines) {
    const line = String(raw);
    const ci = line.indexOf(":");
    if (ci <= 0) continue;
    const file = line.slice(0, ci).replace(/^\.\//, "");
    const body = line.slice(ci + 1);
    byEntry[file] ??= {};
    let m = body.match(/(CONTAINER[A-Z0-9_]*)="\$\{[A-Z0-9_]+:-([^}]+)\}"/);
    if (!m) m = body.match(/(CONTAINER[A-Z0-9_]*)=['"]?([A-Za-z0-9._-]+)['"]?/);
    if (m && !(m[1]! in byEntry[file]!)) byEntry[file]![m[1]!] = m[2]!;
  }
  return byEntry;
}

export function parseVariantFiles(fileLines: string[]): {
  entry: string | null;
  variants: Array<{ rel: string; name: string }>;
  files: Array<{ rel: string; bytes: number }>;
} {
  const files: Array<{ rel: string; bytes: number }> = [];
  for (const line of fileLines) {
    const m = line.match(/^\.?\/?(.+\.sh)\s+(\d+)$/);
    if (m) files.push({ rel: m[1]!.replace(/^\.\//, ""), bytes: Number(m[2]) });
  }
  const entry = files.find((f) => f.rel === "start.sh")?.rel ?? null;
  const label = (rel: string): string => {
    const base = (rel.split("/").pop() ?? rel).replace(/\.sh$/, "").replace(/^start-?/, "");
    if (base) return base;
    // tp1/start.sh → tp1 (directory carries the variant name)
    const dir = rel.includes("/") ? (rel.split("/").slice(0, -1).pop() ?? "") : "";
    return dir.replace(/^tp/, "tp") || "default";
  };
  const variants = files
    .filter(
      (f) =>
        f.rel !== "start.sh" &&
        /(^|\/)start[^/]*\.sh$/.test(f.rel) &&
        (!f.rel.includes("/") || /^tp[0-9a-z]+\//i.test(f.rel)),
    )
    .map((f) => ({ rel: f.rel, name: label(f.rel) }));
  return { entry, variants, files };
}

export interface RecipeMeta {
  port: number | null;
  model: string | null;
  modelFallback: string | null;
  servedName: string | null;
  headIp: string | null;
  workerIp: string | null;
  workerUser: string | null;
  nnodes: number;
  tp: number | null;
  readyTimeoutS: number | null;
  maxModelLen: number | null;
  image: string | null;
  containers: Record<string, string>;
  containersByEntry: Record<string, Record<string, string>>;
  secretPresence: Record<string, boolean>;
  entry: string | null;
  variants: Array<{ rel: string; name: string }>;
  class: "repo" | "script";
  verbs: string[];
}

export interface RecipeProbe {
  ok: boolean;
  error?: string;
  meta: RecipeMeta | null;
  versions: { gitHead: string | null; dirtyBuild: boolean; probedAt: number } | null;
  files: string[];
  verbs: string[];
}

const EMPTY = (error: string): RecipeProbe => ({
  ok: false,
  error,
  meta: null,
  versions: null,
  files: [],
  verbs: [],
});

/** Single funnel: probe stdout → recipe meta (pure). */
export function parseRecipeProbe(out: string, now: () => number = Date.now): RecipeProbe {
  const parsed = parseProbeOutput(out);
  if (parsed.noPath) return EMPTY("folder not found on node");
  const s = parsed.sections;
  const get = (k: string): string => (s[k] ?? []).join("\n");

  const env = parseEnvText(get("env"));
  const example = parseEnvText(get("example"));
  // .env wins where present (recipes source it second).
  const vars = { ...example.vars, ...env.vars };
  const secrets = { ...example.secrets, ...env.secrets };

  const containers = parseContainerLines(s.containers ?? []);
  // The builder pre-trims via `tr -d ' )'`; normalize defensively anyway.
  const verbs = (s.dispatch ?? []).map((v) => v.replace(/\)+$/, "").trim()).filter(Boolean);
  const dispatchOk = verbs.includes("status");
  const { entry, variants, files } = parseVariantFiles(s.files ?? []);
  if (!entry && variants.length === 0) return EMPTY("no start.sh found in folder");

  const gitHead = get("git").trim().split("\n")[0] || null;
  const dirtyBuild = get("dirty").trim().length > 0;
  const defaultEntry = entry ?? variants[0]?.rel ?? null;

  return {
    ok: true,
    meta: {
      port: Number.isInteger(+vars.PORT!) && +vars.PORT! >= 1 && +vars.PORT! <= 65535 ? +vars.PORT! : null,
      model: vars.MODEL ?? null,
      modelFallback: vars.MODEL_FALLBACK ?? null,
      servedName: vars.SERVED_MODEL_NAME ?? null,
      headIp: vars.HEAD_IP ?? null,
      workerIp: vars.WORKER_IP ?? null,
      workerUser: vars.WORKER_USER ?? null,
      nnodes: vars.NNODES ? Math.max(1, parseInt(vars.NNODES, 10) || 1) : vars.WORKER_IP ? 2 : 1,
      tp: vars.TP ? parseInt(vars.TP, 10) || null : null,
      readyTimeoutS: vars.READY_TIMEOUT ? parseInt(vars.READY_TIMEOUT, 10) || null : null,
      maxModelLen: vars.MAX_MODEL_LEN ? parseInt(vars.MAX_MODEL_LEN, 10) || null : null,
      image: vars.IMAGE ?? null,
      containers: containers[defaultEntry ?? ""] ?? {},
      containersByEntry: containers,
      secretPresence: secrets,
      entry,
      variants,
      class: dispatchOk ? "repo" : "script",
      verbs,
    },
    versions: { gitHead, dirtyBuild, probedAt: now() },
    files: files.map((f) => f.rel).slice(0, 40),
    verbs,
  };
}

/** Drift between the version a deployment started with and a fresh probe. */
export function versionDrift(
  startedWith: { gitHead: string | null; dirtyBuild: boolean } | null | undefined,
  current: { gitHead: string | null; dirtyBuild: boolean } | null | undefined,
): { drift: boolean } {
  if (!startedWith?.gitHead || !current) return { drift: false };
  const headMoved = Boolean(current.gitHead && startedWith.gitHead !== current.gitHead);
  return { drift: headMoved || (!startedWith.dirtyBuild && current.dirtyBuild) };
}

// ─── Store ──────────────────────────────────────────────────

const recordSchema = z.object({
  id: z.string(),
  sparkId: z.string(),
  path: z.string(),
  label: z.string().nullable().default(null),
  entry: z.string().nullable().default(null),
  meta: z.any().nullable().default(null),
  versions: z.any().nullable().default(null),
  files: z.array(z.string()).default([]),
  orphaned: z.boolean().default(false),
  probeError: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RecipeRecord = z.infer<typeof recordSchema>;

export interface RecipeStoreDeps {
  filePath: string;
  now?: () => number;
}

/** JSON-file store keyed by recipe id; identity unique on (sparkId, path). */
export class RecipeStore {
  private readonly recipes = new Map<string, RecipeRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: RecipeStoreDeps) {
    this.file = deps.filePath;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const r of raw.recipes ?? []) {
        const parsed = recordSchema.safeParse(r);
        if (parsed.success) this.recipes.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      console.error("[serve-recipes] failed to load state:", err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    // Sync write: probe merges can land back-to-back; async tmp files would race.
    const tmp = `${this.file}.tmp`;
    const recipes = [...this.recipes.values()].sort((a, b) => a.id.localeCompare(b.id));
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, recipes }, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[serve-recipes] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  list(): RecipeRecord[] {
    return [...this.recipes.values()];
  }

  get(id: string): RecipeRecord | null {
    return this.recipes.get(id) ?? null;
  }

  findByPath(sparkId: string, p: string): RecipeRecord | null {
    const key = recipeKey(sparkId, p);
    for (const r of this.recipes.values()) {
      if (recipeKey(r.sparkId, r.path) === key) return r;
    }
    return null;
  }

  /** Register or return the existing record for (sparkId, path). Never probes. */
  register(input: { sparkId: string; path: string; label?: string | null }): { recipe: RecipeRecord; created: boolean } {
    const existing = this.findByPath(input.sparkId, input.path);
    if (existing) return { recipe: existing, created: false };
    let id = makeRecipeId(input.sparkId, input.path);
    if (this.recipes.has(id)) id = `${id}-${this.recipes.size}`;
    const rec: RecipeRecord = {
      id,
      sparkId: input.sparkId,
      path: path.posix.normalize(input.path).replace(/\/+$/, "") || "/",
      label: input.label?.trim() ? input.label.trim().slice(0, 80) : null,
      entry: null,
      meta: null,
      versions: null,
      files: [],
      orphaned: false,
      probeError: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.recipes.set(id, rec);
    this.persist();
    return { recipe: rec, created: true };
  }

  /** Merge a probe result (or error) into the record. */
  updateFromProbe(id: string, probe: RecipeProbe, entry?: string | null): RecipeRecord | null {
    const r = this.recipes.get(id);
    if (!r) return null;
    if (probe.ok && probe.meta) {
      const meta =
        entry && probe.meta.variants.some((v) => v.rel === entry) ? { ...probe.meta, entry } : probe.meta;
      r.meta = meta;
      r.versions = probe.versions;
      r.files = probe.files;
      r.probeError = null;
      if (entry) r.entry = entry;
      else if (!r.entry) r.entry = probe.meta.entry;
    } else if (probe.error) {
      r.probeError = probe.error;
    }
    r.updatedAt = this.now();
    this.persist();
    return r;
  }

  /** Pick a variant entry explicitly (probe auto-fills otherwise). */
  setEntry(id: string, entry: string): RecipeRecord | null {
    const r = this.recipes.get(id);
    if (!r) return null;
    r.entry = entry;
    r.updatedAt = this.now();
    this.persist();
    return r;
  }

  remove(id: string): boolean {
    if (!this.recipes.has(id)) return false;
    this.recipes.delete(id);
    this.persist();
    return true;
  }

  setOrphanedBySpark(sparkId: string, orphaned: boolean): number {
    let n = 0;
    for (const r of this.recipes.values()) {
      if (r.sparkId === sparkId && r.orphaned !== orphaned) {
        r.orphaned = orphaned;
        r.updatedAt = this.now();
        n += 1;
      }
    }
    if (n) this.persist();
    return n;
  }
}
