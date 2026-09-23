# ADR-0006: Clock actuators via spark-clock helper (-lgc + max_perf)

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** agent, power
- **Tags:** power, dgx, clocks
- **Supersedes:** None
- **Superseded by:** None

## Context

DGX Spark GB10 exposes no user power-limit or fan control (firmware-managed; `nvidia-smi -pl` → [N/A]). Owner-confirmed working actuators, both sudo-gated: GPU `nvidia-smi -lgc <min>,<max>` / `-rgc`; CPU per-core `echo <kHz> > /sys/devices/system/cpu/cpu{0..19}/cpufreq/max_perf`.

## Decision drivers

- No raw sudo from the dashboard; auditable, least-privilege control surface.
- Values must resolve against real hardware limits at apply time.

## Considered options

### Option 1 — sudoers-scoped helper (selected)

One installer job deploys `/usr/local/bin/spark-clock` (validated with `visudo -cf`) wrapping exactly those verbs; agent invokes it; profiles (Full/Cool/Whisper/custom) resolve via `--query-supported-clocks` + cpufreq limits; desired profile persists and re-applies on node online.

### Option 2 — Raw sudo commands from the server

No new moving parts, but broad sudo grant and command-injection surface.

## Decision

Option 1; the community `spark_hwmon`/SPBM driver remains an optional, opt-in enhancement, never a dependency.

## Consequences

### Positive

- Narrow, auditable privilege; works over agent or SSH repair path.

### Negative

- Helper must track kernel/sysfs changes.

### Risks and mitigations

- Firmware changes `-lgc` behavior: feature-detect + degrade to read-only (F6).

## Implementation and validation

M5 gate: profile apply survives reboot via reconcile; thermal guard triggers on synthetic temp; non-spark node ⇒ 409; before/after benchmark hook.

## Revisit triggers

- NVIDIA exposing official power-limit/fan controls on GB10.

## References

- PLAN.md §5 F6, §2.5 hardware facts, docs/RUNBOOKS.md (helper install)
