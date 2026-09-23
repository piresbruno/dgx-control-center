import { describe, expect, it } from "vitest";
import { VERSION } from "@cc/shared";
import { buildApp } from "./app.js";

describe("GET /api/health", () => {
  it("returns ok with the shared version", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, name: "controlcenter", version: VERSION });
    expect(typeof body.time).toBe("string");
    await app.close();
  });
});
