import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Unique tmp suffix: concurrent writers to the same target (boot seeding +
 * reconciler tick) each get their own tmp file, so renames never collide.
 * Last rename wins — acceptable for these single-object JSON stores.
 */
function tmpName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
}

/**
 * Atomic JSON persistence (ADR-0003): write to `<file>.tmp` in the same
 * directory, then rename — readers never observe a partial file.
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = tmpName(file);
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/** Read a JSON file, returning `fallback` when absent or unparsable. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Ensure the parent directory exists before the first atomic write. */
export async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
}
