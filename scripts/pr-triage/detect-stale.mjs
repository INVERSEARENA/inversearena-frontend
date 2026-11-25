import { isBot } from "./config.mjs";

export function detectStale(prs, config, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const staleMs = config.staleDays * 24 * 60 * 60 * 1000;
  return prs
    .filter((pr) => !pr.closed && !pr.draft)
    .filter((pr) => !isBot(pr.author, config))
    .filter((pr) => {
      const updated = Date.parse(pr.updatedAt);
      return !Number.isNaN(updated) && nowMs - updated >= staleMs;
    })
    .map((pr) => ({
      number: pr.number,
      author: pr.author,
      updatedAt: pr.updatedAt,
      url: pr.url,
      ageDays: Math.floor((nowMs - Date.parse(pr.updatedAt)) / (24 * 60 * 60 * 1000)),
    }))
    .sort((a, b) => a.number - b.number);
}
