/**
 * Server-side job command registry: REST clients name a KIND; the argv is
 * resolved here. Never accept raw argv from the API — jobs run on real nodes.
 */
export const JOB_KINDS = ["modelctl-version", "modelctl-list-local", "uv-version"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function jobArgv(kind: string): string[] | null {
  switch (kind) {
    case "modelctl-version":
      return ["modelctl", "--version"];
    case "modelctl-list-local":
      return ["modelctl", "list", "--local", "--json"];
    case "uv-version":
      return ["uv", "--version"];
    default:
      return null;
  }
}
