import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "./config.js";

describe("server env schema", () => {
  it("applies safe defaults (loopback bind, port 5566)", () => {
    const env = serverEnvSchema.parse({});
    expect(env).toMatchObject({ PORT: 5566, BIND_HOST: "127.0.0.1", CC_DB_PATH: "config/controlcenter.db" });
  });

  it("coerces and clamps PORT, rejecting out-of-range values", () => {
    expect(serverEnvSchema.parse({ PORT: "8080" }).PORT).toBe(8080);
    expect(() => serverEnvSchema.parse({ PORT: "70000" })).toThrow();
  });
});
