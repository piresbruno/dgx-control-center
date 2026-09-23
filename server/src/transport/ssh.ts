import { spawn } from "node:child_process";

/**
 * Minimal SSH transport (ADR-0002: SSH = bootstrap/repair only). Non-interactive
 * key auth via the system ssh binary; the script arrives on stdin. Injection
 * keeps tests off the network.
 */

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
}

export interface SshResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SshDeps {
  /** Defaults to spawning the system `ssh` binary. */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

export async function runSsh(
  target: SshTarget,
  script: string,
  deps: SshDeps = {},
): Promise<SshResult> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    ...(target.port ? ["-p", String(target.port)] : []),
    `${target.user}@${target.host}`,
    "bash -s",
  ];
  const { promise, resolve, reject } = Promise.withResolvers<SshResult>();
  const child = spawnImpl("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  const timer = deps.timeoutMs
    ? setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ssh timed out after ${deps.timeoutMs}ms`));
      }, deps.timeoutMs)
    : undefined;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  child.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, stdout, stderr });
  });
  child.stdin?.end(script);
  return promise;
}
