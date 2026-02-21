export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export class PaginationQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationQueryError";
  }
}

type CursorToken = {
  createdAt: string;
  id: string;
};

export type CursorSortable = {
  id: string;
  createdAt: string;
};

export type PaginatedResult<T> = {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
};

export function parsePageSize(rawLimit: string | null): number {
  if (rawLimit === null) {
    return DEFAULT_PAGE_SIZE;
  }

  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PaginationQueryError("Query param 'limit' must be a positive integer.");
  }

  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function encodeCursor(cursor: CursorToken): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(encodedCursor: string): CursorToken {
  try {
    const json = Buffer.from(encodedCursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorToken>;

    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") {
      throw new Error("Malformed cursor payload.");
    }

    const timestamp = Date.parse(parsed.createdAt);
    if (Number.isNaN(timestamp)) {
      throw new Error("Malformed cursor timestamp.");
    }

    return {
      id: parsed.id,
      createdAt: new Date(timestamp).toISOString(),
    };
  } catch {
    throw new PaginationQueryError("Query param 'cursor' is invalid.");
  }
}

function compareDesc(a: CursorSortable, b: CursorSortable): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);

  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return b.id.localeCompare(a.id);
}

export function paginateByCursor<T extends CursorSortable>(args: {
  items: T[];
  limit: number;
  cursor?: string | null;
}): PaginatedResult<T> {
  const sorted = [...args.items].sort(compareDesc);
  const cursorToken = args.cursor ? decodeCursor(args.cursor) : null;

  const remaining = cursorToken
    ? sorted.filter((item) => compareDesc(item, cursorToken) > 0)
    : sorted;

  const pageItems = remaining.slice(0, args.limit);
  const hasMore = remaining.length > args.limit;

  return {
    items: pageItems,
    cursor: hasMore
      ? encodeCursor({
          id: pageItems[pageItems.length - 1].id,
          createdAt: pageItems[pageItems.length - 1].createdAt,
        })
      : null,
    hasMore,
  };
}
