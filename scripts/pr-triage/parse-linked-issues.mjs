const ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g;
const CROSS_REPO = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const SAME_REPO = /(?:^|[^\w/])(?:closes|fixes|resolves)\s+#(\d+)\b/gi;

export function stripNoise(body) {
  return (body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
}

export function parseLinkedIssues(body) {
  const text = stripNoise(body);
  const found = new Set();
  let m;
  while ((m = ISSUE_URL.exec(text))) {
    found.add(`${m[1]}/${m[2]}#${m[3]}`.toLowerCase());
  }
  while ((m = CROSS_REPO.exec(text))) {
    found.add(`${m[1]}/${m[2]}#${m[3]}`.toLowerCase());
  }
  while ((m = SAME_REPO.exec(text))) {
    found.add(`#${m[1]}`);
  }
  return [...found].sort();
}
