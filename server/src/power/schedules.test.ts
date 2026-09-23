import { describe, expect, it } from "vitest";
import { activeProfile, inWindow, localTimeIn, validTimezone, ScheduleStore } from "./schedules.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("time windows", () => {
  it("handles normal and midnight-crossing windows", () => {
    expect(inWindow("23:00", "22:00", "06:00")).toBe(true);
    expect(inWindow("05:59", "22:00", "06:00")).toBe(true);
    expect(inWindow("06:00", "22:00", "06:00")).toBe(false);
    expect(inWindow("12:00", "09:00", "17:00")).toBe(true);
    expect(inWindow("08:59", "09:00", "17:00")).toBe(false);
  });

  it("validates timezones and formats local time", () => {
    expect(validTimezone("Europe/Berlin")).toBe(true);
    expect(validTimezone("Mars/Olympus")).toBe(false);
    const utcNoon = new Date("2026-06-01T12:00:00Z");
    expect(localTimeIn("UTC", utcNoon)).toBe("12:00");
    expect(localTimeIn("Europe/Berlin", utcNoon)).toBe("14:00");
    expect(localTimeIn("Mars/Olympus", utcNoon)).toBeNull();
  });
});

describe("activeProfile", () => {
  const schedule = {
    sparkId: "dgx1",
    tz: "UTC",
    rules: [{ profileId: "eco", start: "22:00", end: "06:00" }],
  };

  it("returns the window profile at night and null by day", () => {
    expect(activeProfile(schedule, new Date("2026-06-01T23:00:00Z"))).toBe("eco");
    expect(activeProfile(schedule, new Date("2026-06-01T12:00:00Z"))).toBeNull();
  });

  it("honors the node timezone", () => {
    const berlin = { ...schedule, tz: "Europe/Berlin" };
    // 22:00 UTC = 00:00 CEST (next day) → inside the 22:00–06:00 window.
    expect(activeProfile(berlin, new Date("2026-06-01T22:00:00Z"))).toBe("eco");
    // 20:00 UTC = 22:00 CEST → window start inclusive.
    expect(activeProfile(berlin, new Date("2026-06-01T20:00:00Z"))).toBe("eco");
  });

  it("returns null for invalid tz", () => {
    expect(activeProfile({ ...schedule, tz: "Nowhere/Nowhere" }, new Date())).toBeNull();
  });
});

describe("ScheduleStore", () => {
  it("persists, replaces per node, and validates tz", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-sched-")), "schedules.json");
    const s = new ScheduleStore({ filePath: file });
    expect(s.set("dgx1", "Europe/Berlin", [{ profileId: "eco", start: "22:00", end: "06:00" }])).not.toBeNull();
    expect(s.set("dgx1", "Not/AZone", [])).toBeNull(); // invalid tz rejected
    s.set("dgx1", "UTC", [{ profileId: "quiet", start: "01:00", end: "05:00" }]);
    expect(s.forNode("dgx1")!.rules[0]!.profileId).toBe("quiet");

    const reloaded = new ScheduleStore({ filePath: file });
    expect(reloaded.forNode("dgx1")!.tz).toBe("UTC");
    expect(reloaded.remove("dgx1")).toBe(true);
    expect(reloaded.forNode("dgx1")).toBeNull();
  });
});
