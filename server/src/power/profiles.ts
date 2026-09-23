/**
 * Clock profiles + hardware-limit resolution (M5, user-verified DGX Spark
 * GB10 surface):
 *  - GPU cap: `sudo nvidia-smi -lgc 0,<max>Mhz` … verify `nvidia-smi -q -d CLOCK`
 *  - CPU cap: `sudo cpupower frequency-set -u <N>MHz` … verify `cpupower frequency-info`
 *    (driver cppc_cpufreq, hw limits 338 MHz–2.81 GHz)
 * Profiles: full (no cap), eco (GPU ≤2200 MHz + CPU ≤2.0 GHz), quiet.
 * The agent applies through sudoers NOPASSWD entries scoped to exactly these
 * two commands; boot reconcile re-applies the last desired profile.
 */

export interface ClockProfile {
  id: "full" | "eco" | "quiet";
  name: string;
  /** null = uncapped (no -lgc / no -u command issued). */
  gpuMaxMhz: number | null;
  cpuMaxMhz: number | null;
  description: string;
}

export const CLOCK_PROFILES: ClockProfile[] = [
  {
    id: "full",
    name: "Full",
    gpuMaxMhz: null,
    cpuMaxMhz: null,
    description: "No caps — maximum performance, highest power draw.",
  },
  {
    id: "eco",
    name: "Eco",
    gpuMaxMhz: 2200,
    cpuMaxMhz: 2000,
    description: "GPU ≤2200 MHz, CPU ≤2.0 GHz — the verified eco ceiling.",
  },
  {
    id: "quiet",
    name: "Quiet",
    gpuMaxMhz: 1800,
    cpuMaxMhz: 1500,
    description: "Cooler and quieter — for light serving and desktop use.",
  },
];

export function profileById(id: string): ClockProfile | null {
  return CLOCK_PROFILES.find((p) => p.id === id) ?? null;
}

/** Node-reported hardware limits (from the agent's clock probe). */
export interface HwLimits {
  gpuMinMhz: number | null;
  gpuMaxMhz: number | null;
  cpuMinMhz: number | null;
  cpuMaxMhz: number | null;
}

export interface ResolvedProfile {
  profileId: ClockProfile["id"];
  /** Effective GPU cap after clamping (null = uncapped). */
  gpuMaxMhz: number | null;
  cpuMaxMhz: number | null;
  /** Non-null when a profile value was clamped to the node's hw limit. */
  clamped: boolean;
}

/**
 * Clamp the requested profile into the node's reported hardware limits.
 * Unknown hw limits pass through unchanged (the agent's sudoers commands
 * themselves fail safely if the value is out of range).
 */
export function resolveProfile(profile: ClockProfile, hw: HwLimits | null | undefined): ResolvedProfile {
  const clamp = (value: number | null, min: number | null | undefined, max: number | null | undefined): { value: number | null; clamped: boolean } => {
    if (value == null) return { value: null, clamped: false };
    let v = value;
    let clamped = false;
    if (max != null && value > max) {
      v = max;
      clamped = true;
    }
    if (min != null && v < min) {
      v = min;
      clamped = true;
    }
    return { value: v, clamped };
  };
  const gpu = clamp(profile.gpuMaxMhz, hw?.gpuMinMhz, hw?.gpuMaxMhz);
  const cpu = clamp(profile.cpuMaxMhz, hw?.cpuMinMhz, hw?.cpuMaxMhz);
  return {
    profileId: profile.id,
    gpuMaxMhz: gpu.value,
    cpuMaxMhz: cpu.value,
    clamped: gpu.clamped || cpu.clamped,
  };
}

/** The exact sudo commands the agent runs (sudoers is scoped to these forms). */
export function applyCommands(resolved: ResolvedProfile): string[] {
  const cmds: string[] = [];
  if (resolved.gpuMaxMhz != null) cmds.push(`sudo nvidia-smi -lgc 0,${resolved.gpuMaxMhz}`);
  if (resolved.cpuMaxMhz != null) cmds.push(`sudo cpupower frequency-set -u ${resolved.cpuMaxMhz}MHz`);
  return cmds;
}

/** Full uncapped reset: lift -lgc lock, raise the CPU ceiling back to hw max. */
export function revertCommands(): string[] {
  // Both stay within the sudoers scope (nvidia-smi -lgc/-rgc, cpupower
  // frequency-set -u); 2810 MHz = the GB10 CPU hw maximum.
  return ["sudo nvidia-smi -rgc", "sudo cpupower frequency-set -u 2810MHz"];
}

/** Read-only verification commands (post-apply / reconcile evidence). */
export function verifyCommands(): string[] {
  return ["nvidia-smi -q -d CLOCK", "cpupower frequency-info"];
}
