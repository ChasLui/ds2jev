// Canonical runtime-narrowing helpers shared across every module.
// Single definitions live here — never re-implement these at call sites.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function statusOf(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const { status } = err;
  return typeof status === "number" ? status : undefined;
}
