import { parseLinkedIssues } from "./parse-linked-issues.mjs";
import { isBot, isEnforced } from "./config.mjs";

export function hasUncheckedChecklist(body) {
  const text = (body || "").replace(/\r\n/g, "\n");
  return /- \[ \]/i.test(text);
}

export function checkBody({ body, author, createdAt, config }) {
  const errors = [];
  const bot = isBot(author, config);
  const enforced = isEnforced(createdAt, config);
  const linkedIssues = parseLinkedIssues(body || "");

  if (!bot && enforced) {
    if (linkedIssues.length === 0) errors.push("Missing linked issue (use Closes/Fixes/Resolves #N, owner/repo#N, or issue URL)");
    if (hasUncheckedChecklist(body || "")) errors.push("Checklist has unchecked boxes");
  }

  return {
    ok: errors.length === 0,
    errors,
    linkedIssues,
    bot,
    enforced,
  };
}
