/**
 * Field deltas for arena SSE (#1767).
 *
 * A delta lists top-level snapshot fields that changed. The client applies
 * it onto the last snapshot only when `previousVersion` matches the version
 * it already applied. A gap, or a delta larger than the snapshot, is a full
 * snapshot instead.
 */

export interface FieldDelta {
  replace: Record<string, unknown>;
}

export function buildFieldDelta(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): FieldDelta {
  const replace: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      replace[key] = next[key];
    }
  }
  return { replace };
}

export function applyFieldDelta<T extends Record<string, unknown>>(base: T, delta: FieldDelta): T {
  return { ...base, ...delta.replace };
}

/** True when shipping the delta uses fewer JSON bytes than the full snapshot. */
export function preferDelta(delta: unknown, full: unknown): boolean {
  return JSON.stringify(delta).length < JSON.stringify(full).length;
}
