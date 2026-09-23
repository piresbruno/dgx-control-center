import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomic JSON persistence (ADR-0003): write to `<file>.tmp` in the same
 * directory, then rename — readers never observe a partial file.
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
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
