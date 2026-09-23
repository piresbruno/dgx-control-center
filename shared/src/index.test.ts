import { describe, expect, it } from "vitest";
import {
  VERSION,
  PROTOCOL_VERSION,
  NODE_STATES,
  agentToServer,
  helloMsg,
  metricsMsg,
  serverToAgent,
} from "./index.js";

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

  it("parses server→agent job-run and agent→server metrics as discriminated unions", () => {
    const job = serverToAgent.parse({
      type: "job-run",
      reqId: "r1",
      argv: ["modelctl", "list", "--json"],
    });
    expect(job).toMatchObject({ type: "job-run", reqId: "r1" });

    const snap = agentToServer.parse({
      type: "metrics",
      seq: 42,
      ts: 1_700_000_000_000,
      domains: { gpu: { utilPct: 78 } },
    });
    expect(snap.type).toBe("metrics");
  });

  it("constrains node states to the F1a enum", () => {
    expect(NODE_STATES).toContain("degraded");
    expect(NODE_STATES).not.toContain("maybe");
  });
});
