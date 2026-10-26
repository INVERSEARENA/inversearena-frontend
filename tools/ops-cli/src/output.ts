/**
 * Output: --json prints one JSON document on stdout. Otherwise values are
 * printed as indented `key: value` lines. Progress and warnings go to stderr
 * in both modes, so piping --json output stays clean.
 */
export function render(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value
      .map((item) => {
        const body = render(item, `${indent}  `);
        return `${indent}- ${body.startsWith(`${indent}  `) ? body.slice(indent.length + 2) : body}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, v]) => {
        const nested = v !== null && typeof v === "object" && (!Array.isArray(v) || v.length > 0);
        return nested ? `${indent}${key}:\n${render(v, `${indent}  `)}` : `${indent}${key}: ${render(v)}`;
      })
      .join("\n");
  }
  return String(value);
}

export function print(value: unknown, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${render(value)}\n`);
}

export const log = (message: string) => process.stderr.write(`${message}\n`);
