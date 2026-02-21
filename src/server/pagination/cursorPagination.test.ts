import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PAGE_SIZE,
  PaginationQueryError,
  paginateByCursor,
  parsePageSize,
} from "./cursorPagination.ts";

test("paginateByCursor keeps descending order and emits cursor + hasMore", () => {
  const items = [
    { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "c", createdAt: "2026-01-01T00:01:00.000Z" },
    { id: "b", createdAt: "2026-01-01T00:01:00.000Z" },
    { id: "d", createdAt: "2026-01-01T00:02:00.000Z" },
  ];

  const firstPage = paginateByCursor({ items, limit: 2 });
  assert.deepEqual(
    firstPage.items.map((item) => item.id),
    ["d", "c"]
  );
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.cursor);

  const secondPage = paginateByCursor({ items, limit: 2, cursor: firstPage.cursor });
  assert.deepEqual(
    secondPage.items.map((item) => item.id),
    ["b", "a"]
  );
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.cursor, null);
});

test("paging across full list has no duplicates and no skipped entries", () => {
  const items = Array.from({ length: 27 }, (_, index) => {
    const sequence = index + 1;
    return {
      id: `item-${String(sequence).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, sequence, 0)).toISOString(),
    };
  });

  const seen = new Set<string>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const page = paginateByCursor({ items, limit: 5, cursor });
    for (const item of page.items) {
      assert.equal(seen.has(item.id), false);
      seen.add(item.id);
    }
    hasMore = page.hasMore;
    cursor = page.cursor;
  }

  assert.equal(seen.size, items.length);
});

test("parsePageSize applies defaults and caps max limits", () => {
  assert.equal(parsePageSize(null), 25);
  assert.equal(parsePageSize("999"), MAX_PAGE_SIZE);
});

test("invalid cursor and invalid limits throw PaginationQueryError", () => {
  assert.throws(
    () => paginateByCursor({ items: [], limit: 10, cursor: "broken-token" }),
    PaginationQueryError
  );
  assert.throws(() => parsePageSize("0"), PaginationQueryError);
  assert.throws(() => parsePageSize("2.5"), PaginationQueryError);
});
