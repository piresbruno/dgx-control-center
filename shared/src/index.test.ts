import { describe, expect, it } from "vitest";
import {
  MIN_AGENT_VERSION,
  VERSION,
  PROTOCOL_VERSION,
  NODE_STATES,
  agentToServer,
  helloMsg,
  jobExitMsg,
  jobRunMsg,
  llmMsg,
  metricsMsg,
  serveMsg,
  serverToAgent,
} from "./index.js";
import { compareSemver, isVersionAtLeastFloor, parseSemver } from "./semver.js";

describe("shared contracts", () => {
  it("exposes a semantic version and protocol version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("accepts a valid agent hello", () => {
    const parsed = helloMsg.parse({
      type: "hello",
      sparkId: "dgx1",
      token: "a".repeat(64),
      proto: PROTOCOL_VERSION,
      agentVersion: "0.1.0",
    });
    expect(parsed.sparkId).toBe("dgx1");
  });

  it("rejects hello without a token", () => {
    expect(() =>
      helloMsg.parse({ type: "hello", sparkId: "dgx1", proto: 1, agentVersion: "0.1.0" }),
    ).toThrow();
  });

  it("rejects metrics with negative seq", () => {
    expect(() =>
      metricsMsg.parse({ type: "metrics", seq: -1, ts: Date.now(), domains: { gpu: {} } }),
    ).toThrow();
  });

  it("validates llm probe snapshots with bounded ports", () => {
    const parsed = llmMsg.parse({
      type: "llm",
      ports: [{ port: 8888, available: true, backend: "vllm", modelId: "glm-5.3" }],
    });
    expect(parsed.ports[0]?.port).toBe(8888);
    expect(() => llmMsg.parse({ type: "llm", ports: [{ port: 99999, available: true }] })).toThrow();
  });

  it("requires job-exit code to be an int or null (signal death)", () => {
    expect(jobExitMsg.parse({ type: "job-exit", reqId: "r1", code: 0 }).code).toBe(0);
    expect(jobExitMsg.parse({ type: "job-exit", reqId: "r1", code: null }).code).toBeNull();
    expect(() => jobExitMsg.parse({ type: "job-exit", reqId: "r1", code: 1.5 })).toThrow();
  });

  it("restricts serve actions to start/stop/status", () => {
    expect(serveMsg.parse({ type: "serve", reqId: "s1", action: "start", scriptId: "glm" }).action).toBe("start");
    expect(() => serveMsg.parse({ type: "serve", reqId: "s1", action: "exec", scriptId: "glm" })).toThrow();
  });

  it("routes job-run as server→agent and pong as agent→server", () => {
    const job = serverToAgent.parse({
      type: "job-run",
      reqId: "r1",
      argv: ["modelctl", "list", "--json"],
    });
    expect(job).toMatchObject({ type: "job-run", reqId: "r1" });
    expect(serverToAgent.safeParse({ type: "pong" }).success).toBe(false);
    expect(agentToServer.safeParse({ type: "pong" }).success).toBe(true);
    expect(agentToServer.safeParse({ type: "welcome", proto: 1, config: {} }).success).toBe(false);
  });

  it("constrains node states to the F1a enum", () => {
    expect(NODE_STATES).toContain("degraded");
    expect(NODE_STATES).not.toContain("maybe");
  });
});

describe("version floor", () => {
  it("parses full, short and prefixed versions", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("v2.3")).toEqual({ major: 2, minor: 3, patch: 0 });
    expect(parseSemver("0.1.0-beta.1+build")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseSemver("not-a-version")).toBeNull();
  });

  it("orders versions", () => {
    expect(compareSemver(parseSemver("1.0.0")!, parseSemver("1.0.1")!)).toBeLessThan(0);
    expect(compareSemver(parseSemver("2.10.0")!, parseSemver("2.9.9")!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("3.0.0")!, parseSemver("3.0.0")!)).toBe(0);
  });

  it("enforces the agent floor and rejects garbage", () => {
    const floor = MIN_AGENT_VERSION;
    expect(isVersionAtLeastFloor(floor, floor)).toBe(true);
    expect(isVersionAtLeastFloor("9.9.9")).toBe(true);
    expect(isVersionAtLeastFloor("0.0.9")).toBe(false);
    expect(isVersionAtLeastFloor("")).toBe(false);
    expect(isVersionAtLeastFloor("abc", "1.0.0")).toBe(false);
  });
});
