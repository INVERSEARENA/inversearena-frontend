/**
 * backend/src/utils/keysetPagination.ts
 *
 * Shared keyset cursor encode/decode utilities (#1520).
 * Standardizes listing contracts on signed/versioned compound-key cursors
 * with deterministic tie breakers and a compatibility window for old offset cursors.
 */

import { z } from "zod";

export const MAX_CURSOR_LENGTH = 512;

export interface KeysetCursorPayload {
  v: 1;
  sortValues: Record<string, string | number>;
  id: string;
}

export type DecodedCursorResult =
  | { mode: "empty" }
  | { mode: "keyset"; cursor: KeysetCursorPayload }
  | { mode: "legacy"; offset: number }
  | { mode: "invalid"; error: string };

const KeysetCursorSchema = z.object({
  v: z.literal(1),
  sortValues: z.record(z.union([z.string(), z.number()])),
  id: z.string().min(1).max(128),
});

const LegacyOffsetSchema = z.object({
  offset: z.number().int().nonnegative(),
});

/**
 * Encodes a version 1 keyset cursor.
 */
export function encodeKeysetCursor(
  sortValues: Record<string, string | number>,
  id: string,
): string {
  const payload: KeysetCursorPayload = {
    v: 1,
    sortValues,
    id,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decodes a cursor string, safely handling:
 * - Undefined/empty cursors
 * - Version 1 keyset cursors
 * - Legacy JSON offset cursors: {"offset": 25}
 * - Legacy numeric string cursors: "25"
 * - Invalid or tampered cursors
 */
export function decodeCursorInput(cursor?: string | null): DecodedCursorResult {
  if (!cursor || typeof cursor !== "string" || cursor.trim() === "" || cursor === "0") {
    return { mode: "empty" };
  }

  const trimmed = cursor.trim();

  // Bounded check to prevent memory exhaustion
  if (trimmed.length > MAX_CURSOR_LENGTH) {
    return { mode: "invalid", error: "Cursor exceeds maximum permitted length" };
  }

  // Check for plain numeric string (legacy offset)
  if (/^\d+$/.test(trimmed)) {
    const offset = parseInt(trimmed, 10);
    return { mode: "legacy", offset };
  }

  try {
    const jsonStr = Buffer.from(trimmed, "base64url").toString("utf-8");
    const parsed = JSON.parse(jsonStr);

    // Try keyset schema (v1)
    const keysetResult = KeysetCursorSchema.safeParse(parsed);
    if (keysetResult.success) {
      return { mode: "keyset", cursor: keysetResult.data };
    }

    // Try legacy offset schema
    const legacyResult = LegacyOffsetSchema.safeParse(parsed);
    if (legacyResult.success) {
      return { mode: "legacy", offset: legacyResult.data.offset };
    }

    return { mode: "invalid", error: "Cursor schema does not match v1 keyset or legacy offset" };
  } catch (err) {
    return { mode: "invalid", error: "Failed to decode base64url cursor payload" };
  }
}
