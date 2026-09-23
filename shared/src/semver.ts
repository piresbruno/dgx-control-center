import { MIN_AGENT_VERSION } from "./version.js";

/**
 * Version floor (F1a): server tolerates any agent ≥ MIN_AGENT_VERSION and
 * offers an upgrade job otherwise. Deliberately minimal semver comparison —
 * numeric major/minor/patch only; prerelease/build suffixes are stripped.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(input: string): SemVer | null {
  const core = input.trim().replace(/^[vV]/, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  while (nums.length < 3) nums.push(0);
  const [major, minor, patch] = nums as [number, number, number];
  return { major, minor, patch };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies the floor (defaults to MIN_AGENT_VERSION). */
export function isVersionAtLeastFloor(version: string, floor: string = MIN_AGENT_VERSION): boolean {
  const v = parseSemver(version);
  const f = parseSemver(floor);
  if (!v || !f) return false;
  return compareSemver(v, f) >= 0;
}
