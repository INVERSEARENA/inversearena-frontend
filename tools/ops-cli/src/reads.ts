/** Read helpers shared by the inspection commands. */

/** Read several views; one failing read is reported in place, not fatal. */
export async function readAll(reads: Record<string, () => Promise<unknown>>): Promise<Record<string, unknown>> {
  const keys = Object.keys(reads);
  const settled = await Promise.allSettled(keys.map((key) => reads[key]!()));
  return Object.fromEntries(
    settled.map((result, i) => [keys[i], result.status === "fulfilled" ? result.value : { error: String(result.reason?.message ?? result.reason) }]),
  );
}

/** Read pages until one comes back empty or short. */
export async function paged<T>(readPage: (page: number) => Promise<T[]>, pageSize: number, maxPages: number): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const items = await readPage(page);
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all;
}
