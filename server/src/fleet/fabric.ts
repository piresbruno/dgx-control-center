/**
 * Cluster fabric probe (M6): CX7 (mlx5) link state + RoCE/error counters per
 * node, collected read-only through the agent job channel. Nodes without
 * mlx5 devices report an empty list — the UI shows a "no fabric" state.
 */

/** One-shot probe: mlx5 interfaces, link state/speed, error counters. */
export function buildFabricProbeCommand(): string {
  return [
    "echo __F_IFACES__",
    'for d in /sys/class/net/*; do',
    '  if [ -d "$d/device/driver" ] && basename "$(readlink -f "$d/device/driver")" | grep -q mlx5; then',
    '    b=$(basename "$d")',
    '    speed=$(cat "$d/speed" 2>/dev/null || echo 0)',
    '    oper=$(cat "$d/operstate" 2>/dev/null || echo unknown)',
    '    echo "$b $speed $oper"',
    '  fi',
    'done',
    "echo __F_ERRORS__",
    'for d in /sys/class/net/*; do',
    '  if [ -d "$d/device/driver" ] && basename "$(readlink -f "$d/device/driver")" | grep -q mlx5; then',
    '    b=$(basename "$d")',
    '    ethtool -S "$b" 2>/dev/null | grep -Ei "roce|crc|symbol_error|discards" | head -12 | while read -r k v rest; do echo "$b $k $v"; done',
    '  fi',
    'done',
    "echo __F_END__",
  ].join("\n");
}

export interface FabricIface {
  name: string;
  speedMhz: number | null;
  operState: string | null;
}

export interface FabricCounters {
  iface: string;
  counter: string;
  value: number | null;
}

export interface FabricReport {
  ifaces: FabricIface[];
  counters: FabricCounters[];
}

export function parseFabricProbe(out: string): FabricReport {
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of String(out ?? "").split("\n")) {
    const m = line.trim().match(/^__F_([A-Z]+)__$/);
    if (m) {
      cur = m[1]!.toLowerCase();
      sections[cur] = [];
      continue;
    }
    if (cur) sections[cur]!.push(line);
  }
  const ifaces: FabricIface[] = [];
  for (const line of sections.ifaces ?? []) {
    const [name, speed, oper] = line.trim().split(/\s+/);
    if (!name) continue;
    ifaces.push({ name, speedMhz: speed && /^\d+$/.test(speed) ? Number(speed) : null, operState: oper ?? null });
  }
  const counters: FabricCounters[] = [];
  for (const line of sections.errors ?? []) {
    const [iface, counter, value] = line.trim().split(/\s+/);
    if (!iface || !counter) continue;
    counters.push({ iface, counter, value: value && /^\d+$/.test(value) ? Number(value) : null });
  }
  return { ifaces, counters };
}
