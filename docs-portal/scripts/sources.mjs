import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { extractTitle, githubSlug, titleFromPath } from "./markdown.mjs";

export const SOURCE_ROOTS = [
  { area: "root", dir: ".", label: "Root", recursive: false },
  { area: "docs", dir: "docs", label: "Docs", recursive: true },
  { area: "backend", dir: "backend/docs", label: "Backend", recursive: true },
  { area: "frontend", dir: "frontend/docs", label: "Frontend", recursive: true },
  { area: "contract", dir: "contract", label: "Contract", recursive: true },
];

function walkMarkdown(directory, rootDir, recursive) {
  const files = [];
  if (!existsSync(directory)) return files;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !["node_modules", ".git", "dist", "target"].includes(entry.name)) {
        files.push(...walkMarkdown(fullPath, rootDir, recursive));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(rootDir, fullPath).split("\\").join("/"));
    }
  }

  return files.sort();
}

export function slugForSource(area, relativePath) {
  const pathPart = githubSlug(relativePath.replace(/\.md$/i, "").replace(/[\\/]+/g, "-"));
  return pathPart ? `${githubSlug(area)}-${pathPart}` : githubSlug(area);
}

export function collectMarkdownSources(rootDir) {
  const sources = [];

  for (const root of SOURCE_ROOTS) {
    const directory = resolve(rootDir, root.dir);
    const paths = walkMarkdown(directory, rootDir, root.recursive);

    for (const sourcePath of paths) {
      const relativePath = relative(resolve(rootDir, root.dir), resolve(rootDir, sourcePath))
        .split("\\")
        .join("/");
      const markdown = readFileSync(resolve(rootDir, sourcePath), "utf8");
      const fallback = titleFromPath(sourcePath);

      sources.push({
        area: root.area,
        areaLabel: root.label,
        relativePath,
        sourcePath,
        slug: slugForSource(root.area, relativePath),
        title: extractTitle(markdown, fallback),
      });
    }
  }

  return sources;
}

export function buildNav(sources) {
  return SOURCE_ROOTS.map((root) => ({
    area: root.area,
    label: root.label,
    items: sources
      .filter((source) => source.area === root.area)
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
      .map((source) => ({
        slug: source.slug,
        title: source.title,
        sourcePath: source.sourcePath,
      })),
  })).filter((section) => section.items.length > 0);
}

export function assertNavIntegrity(sources, nav) {
  const slugs = sources.map((source) => source.slug);
  const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate documentation slugs: ${[...new Set(duplicates)].sort().join(", ")}`);
  }

  const navSlugs = nav.flatMap((section) => section.items.map((item) => item.slug));
  const missing = slugs.filter((slug) => !navSlugs.includes(slug));
  const orphans = navSlugs.filter((slug) => !slugs.includes(slug));
  if (missing.length > 0 || orphans.length > 0 || navSlugs.length !== slugs.length) {
    throw new Error(
      `Navigation coverage failed: missing=${missing.join(",") || "none"} orphan=${orphans.join(",") || "none"}`,
    );
  }

  return true;
}
