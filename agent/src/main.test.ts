import { describe, expect, it } from "vitest";
import { VERSION, PROTOCOL_VERSION } from "@cc/shared";
import { agentVersionString } from "./main.js";

describe("agent", () => {
  it("reports version and protocol consistently with shared", () => {
    expect(agentVersionString()).toBe(`controlcenter-agent ${VERSION} · proto ${PROTOCOL_VERSION}`);
  });
});
