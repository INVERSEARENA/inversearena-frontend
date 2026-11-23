function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;");
}

export function renderBodyComment(result) {
  const marker = "<!-- pr-triage:body -->";
  if (result.ok) {
    return `${marker}\nPR triage body check: OK.`;
  }
  const lines = result.errors.map((e) => `- ${esc(e)}`).join("\n");
  return `${marker}\n## PR triage: body checks failed\n\n${lines}\n\nPlease update the PR description.`;
}

export function renderDuplicateComment(group) {
  const marker = `<!-- pr-triage:duplicate:${esc(group.issueKey)} -->`;
  const list = group.prs.map((p) => `- #${p.number} by @${esc(p.author)} ${esc(p.url || "")}`).join("\n");
  return `${marker}\n## PR triage: possible duplicate work\n\nThese open PRs reference the same issue \`${esc(group.issueKey)}\`:\n\n${list}\n\nThis is advisory only; maintainers should confirm before closing anything.`;
}

export function renderStaleComment(stale, config) {
  const marker = "<!-- pr-triage:stale -->";
  return `${marker}\n## PR triage: stale PR\n\nThis PR has had no activity for ${stale.ageDays} days (threshold ${config.staleDays} days).\n\nIf this is still active, please push an update or leave a comment. cc @INVERSEARENA/maintainers`;
}

export async function upsertComment({ github, context, issueNumber, marker, body }) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(marker));
  if (existing) {
    if (existing.body === body) return { updated: false, id: existing.id };
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return { updated: true, id: existing.id };
  }
  const created = await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return { created: true, id: created.data.id };
}
