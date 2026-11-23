import { parseLinkedIssues } from "./parse-linked-issues.mjs";
import { isBot } from "./config.mjs";

export function detectDuplicates(prs, config) {
  const groups = new Map();
  for (const pr of prs) {
    if (pr.closed || pr.draft) continue;
    if (isBot(pr.author, config)) continue;
    const issues = parseLinkedIssues(pr.body || "");
    for (const issue of issues) {
      const key = issue.toLowerCase();
      const arr = groups.get(key) || [];
      arr.push(pr);
      groups.set(key, arr);
    }
  }
  const results = [];
  for (const [issueKey, group] of groups.entries()) {
    const unique = [...new Map(group.map((p) => [p.number, p])).values()];
    if (unique.length < 2) continue;
    results.push({ issueKey, prs: unique.sort((a, b) => a.number - b.number) });
  }
  return results.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
}
