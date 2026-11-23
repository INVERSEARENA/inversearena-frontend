import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { extractHeadings, githubSlug, stripIgnoredSections, titleFromPath } from "./markdown.mjs";
import { assertNavIntegrity, buildNav, collectMarkdownSources, slugForSource } from "./sources.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const portalDir = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(portalDir, "..");
const defaultAllowlistPath = join(portalDir, "link-allowlist.json");
const linkPattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const extraLinkSources = [
  { sourcePath: "backend/README.md", area: "backend" },
  { sourcePath: "frontend/README.md", area: "frontend" },
  { sourcePath: "frontend/IMPLEMENTATION_SUMMARY.md", area: "frontend" },
];

export function collectLinkSources(rootDir = repoRoot) {
  const sources = collectMarkdownSources(rootDir);

  for (const extra of extraLinkSources) {
    if (!existsSync(join(rootDir, extra.sourcePath))) continue;
    const relativePath = basename(extra.sourcePath);

    sources.push({
      area: extra.area,
      areaLabel: extra.area === "backend" ? "Backend" : "Frontend",
      relativePath,
      sourcePath: extra.sourcePath,
      slug: slugForSource(extra.area, relativePath),
      title: titleFromPath(extra.sourcePath),
      linkOnly: true,
    });
  }

  return sources;
}

export function loadAllowlist(filePath = defaultAllowlistPath) {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

export function collectMarkdownLinks(markdown) {
  const source = stripIgnoredSections(markdown).replace(/`[^`]*`/g, "");
  const links = [];
  let match;

  linkPattern.lastIndex = 0;
  while ((match = linkPattern.exec(source)) !== null) {
    const href = match[1].replace(/^<|>$/g, "");
    const line = source.slice(0, match.index).split("\n").length;
    links.push({ href, line });
  }

  return links;
}

function isExternal(href) {
  return /^(https?:|mailto:)/i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

export function parseHref(href) {
  const hashIndex = href.indexOf("#");
  const queryIndex = href.indexOf("?");
  const cut = [hashIndex, queryIndex].filter((index) => index >= 0);
  const pathEnd = cut.length > 0 ? Math.min(...cut) : href.length;
  let pathname = href.slice(0, pathEnd);
  const hash = hashIndex >= 0 ? href.slice(hashIndex + 1, queryIndex >= 0 ? queryIndex : undefined) : "";

  if (pathname.startsWith("<") && pathname.endsWith(">")) pathname = pathname.slice(1, -1);

  return {
    pathname: decodeURIComponent(pathname),
    hash: decodeURIComponent(hash),
  };
}

function resolveTarget({ rootDir, sourcePath, pathname }) {
  if (!pathname) return resolve(rootDir, sourcePath);
  if (pathname.startsWith("/")) return resolve(rootDir, `.${pathname}`);
  if (isAbsolute(pathname)) return pathname;
  return resolve(dirname(resolve(rootDir, sourcePath)), pathname);
}

function withinRoot(rootDir, targetPath) {
  const relativePath = relative(rootDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function checkMarkdownLinks({
  rootDir = repoRoot,
  sources = collectLinkSources(rootDir),
  allowlist = loadAllowlist(),
} = {}) {
  const problems = [];
  const navSources = sources.filter((source) => !source.linkOnly);

  try {
    assertNavIntegrity(navSources, buildNav(navSources));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const allowed = new Set(allowlist.map((entry) => `${entry.source}|${entry.target}`));

  for (const source of sources) {
    const markdown = readFileSync(join(rootDir, source.sourcePath), "utf8");

    for (const link of collectMarkdownLinks(markdown)) {
      if (isExternal(link.href)) continue;

      const key = `${source.sourcePath}|${link.href}`;
      if (allowed.has(key)) continue;

      const { pathname, hash } = parseHref(link.href);
      const targetPath = resolveTarget({ rootDir, sourcePath: source.sourcePath, pathname });
      const displayTarget = relative(rootDir, targetPath).split("\\").join("/") || ".";

      if (!withinRoot(rootDir, targetPath)) {
        problems.push(`${source.sourcePath}:${link.line}: target escapes repository: ${link.href}`);
        continue;
      }

      if (!existsSync(targetPath)) {
        problems.push(`${source.sourcePath}:${link.line}: missing target ${link.href} (${displayTarget})`);
        continue;
      }

      if (!hash || !targetPath.endsWith(".md")) continue;

      const targetMarkdown = readFileSync(targetPath, "utf8");
      const anchors = new Set(extractHeadings(targetMarkdown).map((heading) => heading.slug));
      if (!anchors.has(githubSlug(hash))) {
        problems.push(`${source.sourcePath}:${link.line}: unknown anchor ${link.href} (${displayTarget})`);
      }
    }
  }

  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const sources = collectLinkSources(repoRoot);
  const problems = checkMarkdownLinks({ sources });

  if (problems.length > 0) {
    console.error(`Found ${problems.length} documentation link problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`Checked ${sources.length} Markdown files; all links and navigation are valid.`);
  }
}
