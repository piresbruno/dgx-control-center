import { describe, expect, it } from "vitest";
import {
  buildRecipeProbeCommand,
  makeRecipeId,
  parseContainerLines,
  parseEnvText,
  parseProbeOutput,
  parseRecipeProbe,
  parseVariantFiles,
  recipeKey,
  validRecipeId,
  validRecipePath,
  versionDrift,
  RecipeStore,
} from "./recipes.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("recipe ids and paths", () => {
  it("validates ids and absolute paths", () => {
    expect(validRecipeId("glm53-tp4")).toBe(true);
    expect(validRecipeId("-bad")).toBe(false);
    expect(validRecipeId("../evil")).toBe(false);
    expect(validRecipePath("/home/pires/recipes/GLM")).toBe(true);
    expect(validRecipePath("relative/path")).toBe(false);
    expect(validRecipePath("/has\0null")).toBe(false);
  });

  it("derives stable identity and ids", () => {
    expect(recipeKey("dgx1", "/a/b/")).toBe(recipeKey("dgx1", "/a/b"));
    expect(recipeKey("dgx1", "/a/b")).not.toBe(recipeKey("dgx2", "/a/b"));
    const id = makeRecipeId("dgx1", "/home/pires/recipes/GLM-5.3-Flash");
    expect(id).toMatch(/^glm-5\.3-flash-[0-9a-f]{8}$/);
    expect(makeRecipeId("dgx1", "/home/pires/recipes/GLM-5.3-Flash")).toBe(id);
  });
});

describe("probe builder", () => {
  it("quotes the path and emits bounded sections", () => {
    const cmd = buildRecipeProbeCommand("/home/p/my recipes/GLM");
    expect(cmd).toContain("cd '/home/p/my recipes/GLM'");
    expect(cmd).toContain("__P_DISPATCH__");
    expect(cmd).toContain("head -c 24000 .env");
  });
});

describe("probe parsers", () => {
  it("splits marker sections", () => {
    const out = "__P_FILES__\n./start.sh 1024\n./start-tp4.sh 2048\n__P_GIT__\nabc123\n__P_END__";
    const parsed = parseProbeOutput(out);
    expect(parsed.sections.files).toEqual(["./start.sh 1024", "./start-tp4.sh 2048"]);
    expect(parsed.sections.git).toEqual(["abc123"]);
  });

  it("flags missing folders", () => {
    expect(parseProbeOutput("__P_NOPATH__").noPath).toBe(true);
  });

  it("parses env text with secret presence and public keys", () => {
    const { vars, secrets } = parseEnvText(
      [
        "# comment",
        "PORT=8888",
        "MODEL=deepseek-v4-flash-dspark",
        'VLLM_API_KEY="sk-secret"',
        "HF_TOKEN=hf_x",
        "EMPTY_SECRET=",
        "UNRELATED_VALUE=dropped",
      ].join("\n"),
    );
    expect(vars).toEqual({ PORT: "8888", MODEL: "deepseek-v4-flash-dspark" });
    expect(secrets).toEqual({ VLLM_API_KEY: true, HF_TOKEN: true });
    expect(JSON.stringify(secrets)).not.toContain("sk-secret");
  });

  it("scrapes per-entry container defaults", () => {
    const byEntry = parseContainerLines([
      'start.sh:CONTAINER_HEAD="${CONTAINER_HEAD:-glm53-head}"',
      "start-tp4.sh:CONTAINER_HEAD='glm53-tp4-head'",
    ]);
    expect(byEntry["start.sh"]).toEqual({ CONTAINER_HEAD: "glm53-head" });
    expect(byEntry["start-tp4.sh"]).toEqual({ CONTAINER_HEAD: "glm53-tp4-head" });
  });

  it("finds the entry and labeled variants", () => {
    const { entry, variants } = parseVariantFiles(["./start.sh 1024", "./start-tp4.sh 2048", "./tp1/start.sh 512", "./tests/x.sh 10"]);
    expect(entry).toBe("start.sh");
    expect(variants).toEqual([
      { rel: "start-tp4.sh", name: "tp4" },
      { rel: "tp1/start.sh", name: "tp1" },
    ]);
  });
});

describe("parseRecipeProbe funnel", () => {
  const fullProbe = [
    "__P_FILES__",
    "./start.sh 1024",
    "./start-tp4.sh 2048",
    "__P_GIT__",
    "abc1234",
    "__P_DIRTY__",
    "__P_DISPATCH__",
    "start)",
    "stop)",
    "status)",
    "__P_ENV__",
    "PORT=8888",
    "MODEL=glm53",
    "WORKER_IP=10.0.30.12",
    "NNODES=2",
    "VLLM_API_KEY=sk-x",
    "__P_EXAMPLE__",
    "PORT=8888",
    "__P_CONTAINERS__",
    'start.sh:CONTAINER_HEAD="${CONTAINER_HEAD:-glm53-head}"',
    "__P_END__",
  ].join("\n");

  it("assembles repo-class meta with defaults merged", () => {
    const probe = parseRecipeProbe(fullProbe, () => 1_000);
    expect(probe.ok).toBe(true);
    expect(probe.meta).toMatchObject({
      port: 8888,
      model: "glm53",
      nnodes: 2,
      entry: "start.sh",
      class: "repo",
      containers: { CONTAINER_HEAD: "glm53-head" },
    });
    expect(probe.meta?.secretPresence).toEqual({ VLLM_API_KEY: true });
    expect(probe.versions).toEqual({ gitHead: "abc1234", dirtyBuild: false, probedAt: 1_000 });
    expect(probe.verbs).toEqual(["start", "stop", "status"]);
  });

  it("classifies script-class when status verb is missing and infers nnodes", () => {
    const probe = parseRecipeProbe(fullProbe.replace("status)\n", "").replace("NNODES=2\n", ""), () => 1_000);
    expect(probe.meta?.class).toBe("script");
    expect(probe.meta?.nnodes).toBe(2); // from WORKER_IP
  });

  it("reports missing folder and missing entry", () => {
    expect(parseRecipeProbe("__P_NOPATH__").error).toContain("not found");
    expect(parseRecipeProbe("__P_FILES__\n./README.md 10\n__P_END__").error).toContain("no start.sh");
  });

  it("detects drift on head move or new dirty state", () => {
    expect(versionDrift({ gitHead: "aaa", dirtyBuild: false }, { gitHead: "aaa", dirtyBuild: false })).toEqual({ drift: false });
    expect(versionDrift({ gitHead: "aaa", dirtyBuild: false }, { gitHead: "bbb", dirtyBuild: false }).drift).toBe(true);
    expect(versionDrift({ gitHead: "aaa", dirtyBuild: false }, { gitHead: "aaa", dirtyBuild: true }).drift).toBe(true);
  });
});

describe("RecipeStore", () => {
  async function store() {
    const file = join(await mkdtemp(join(tmpdir(), "cc-recipes-")), "serve-recipes.json");
    return new RecipeStore({ filePath: file, now: () => 5_000 });
  }

  it("registers with (sparkId,path) identity; re-register returns existing", async () => {
    const s = await store();
    const first = s.register({ sparkId: "dgx1", path: "/opt/recipes/GLM/", label: "GLM" });
    expect(first.created).toBe(true);
    expect(first.recipe.path).toBe("/opt/recipes/GLM");
    const again = s.register({ sparkId: "dgx1", path: "/opt/recipes/GLM" });
    expect(again.created).toBe(false);
    expect(again.recipe.id).toBe(first.recipe.id);
  });

  it("merges probe results and persists them across reloads", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-recipes-")), "serve-recipes.json");
    const s = new RecipeStore({ filePath: file, now: () => 5_000 });
    const { recipe } = s.register({ sparkId: "dgx1", path: "/opt/recipes/GLM" });
    const probe = parseRecipeProbe(
      ["__P_FILES__", "./start.sh 10", "__P_DISPATCH__", "start)", "__P_ENV__", "PORT=8888", "__P_END__"].join("\n"),
      () => 6_000,
    );
    s.updateFromProbe(recipe.id, probe);
    const reloaded = new RecipeStore({ filePath: file, now: () => 7_000 });
    const merged = reloaded.get(recipe.id)!;
    expect(merged.meta?.port).toBe(8888);
    expect(merged.versions?.probedAt).toBe(6_000);
  });

  it("records probe errors and removes records", async () => {
    const s = await store();
    const { recipe } = s.register({ sparkId: "dgx1", path: "/gone" });
    s.updateFromProbe(recipe.id, { ok: false, error: "folder not found on node", meta: null, versions: null, files: [], verbs: [] });
    expect(s.get(recipe.id)!.probeError).toContain("not found");
    expect(s.remove(recipe.id)).toBe(true);
    expect(s.get(recipe.id)).toBeNull();
  });

  it("orphans all recipes of a spark", async () => {
    const s = await store();
    s.register({ sparkId: "dgx1", path: "/a" });
    s.register({ sparkId: "dgx1", path: "/b" });
    s.register({ sparkId: "dgx2", path: "/c" });
    expect(s.setOrphanedBySpark("dgx1", true)).toBe(2);
    expect(s.list().filter((r) => r.orphaned)).toHaveLength(2);
  });
});
