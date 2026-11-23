import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, hasMermaid, plainText, renderMarkdown, stripIgnoredSections } from "./markdown.mjs";
import { assertNavIntegrity, buildNav, collectMarkdownSources } from "./sources.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const portalDir = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(portalDir, "..");

const styles = `:root {
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
}
body { margin: 0; }
.layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); min-height: 100vh; }
.sidebar { border-right: 1px solid #8884; padding: 1.5rem; position: sticky; top: 0; height: 100vh; overflow: auto; }
.sidebar h2 { font-size: 0.95rem; margin: 1.5rem 0 0.4rem; text-transform: uppercase; letter-spacing: 0.08em; }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li { margin: 0.15rem 0; }
.sidebar a { text-decoration: none; }
.sidebar a[aria-current="page"] { font-weight: 700; text-decoration: underline; }
.content { max-width: 60rem; padding: 2rem 3rem 6rem; }
.content h1, .content h2, .content h3 { line-height: 1.25; }
.content img { max-width: 100%; }
pre { overflow-x: auto; padding: 1rem; border: 1px solid #8884; border-radius: 0.5rem; background: #8882; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.search { margin: 1rem 0; }
.search input { box-sizing: border-box; width: 100%; padding: 0.55rem 0.7rem; }
.search ul { list-style: none; margin: 0.25rem 0 0; padding: 0; }
.search li { margin: 0.25rem 0; }
.source { color: #888; font-size: 0.85rem; }
@media (max-width: 800px) {
  .layout { display: block; }
  .sidebar { height: auto; position: static; }
  .content { padding: 1.5rem; }
}
`;

const searchScript = `const input = document.querySelector("[data-search]");
const results = document.querySelector("[data-search-results]");
if (input && results) {
  const response = await fetch(new URL("../search-index.json", import.meta.url));
  const documents = await response.json();
  const render = () => {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      results.replaceChildren();
      return;
    }
    const matches = documents
      .filter((entry) => [entry.title, entry.area, entry.sourcePath, entry.text].join(" ").toLowerCase().includes(query))
      .slice(0, 10);
    results.replaceChildren(
      ...matches.map((entry) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = new URL("pages/" + entry.slug + ".html", import.meta.url).href;
        link.textContent = entry.title + " — " + entry.area;
        item.append(link);
        return item;
      }),
    );
  };
  input.addEventListener("input", render);
}
`;

function rewriteGeneratedDataLinks(markdown, sourcePath, rootDir) {
  const dataDir = join(portalDir, "data");

  return markdown.replace(/\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (full, href, title) => {
    const hashIndex = href.indexOf("#");
    const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
    const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
    if (!pathPart.includes("docs-portal/data/")) return full;

    const absolute = resolve(dirname(join(rootDir, sourcePath)), pathPart);
    const dataRelative = relative(dataDir, absolute).split("\\").join("/");
    if (dataRelative.startsWith("..") || dataRelative.startsWith("/")) return full;

    const suffix = title ? ` "${title}"` : "";
    return `](../data/${dataRelative}${hash}${suffix})`;
  });
}

function renderNav(sections, prefix, activeSlug) {
  const groups = sections.map((section) => {
    const links = section.items
      .map((item) => {
        const current = item.slug === activeSlug ? ' aria-current="page"' : "";
        return `<li><a href="${prefix}pages/${escapeHtml(item.slug)}.html"${current}>${escapeHtml(item.title)}</a></li>`;
      })
      .join("\n");
    return `<h2>${escapeHtml(section.label)}</h2>\n<ul>\n${links}\n</ul>`;
  });

  return `<aside class="sidebar">
<a class="brand" href="${prefix}index.html"><strong>InverseArena Docs</strong></a>
<div class="search">
<input type="search" data-search placeholder="Search documentation" aria-label="Search documentation">
<ul data-search-results></ul>
</div>
${groups.join("\n")}
</aside>`;
}

function renderPage({ title, body, sourcePath, sections, slug, prefix, hasMermaidBlock }) {
  const mermaid = hasMermaidBlock
    ? `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false });
mermaid.run({ querySelector: "pre.language-mermaid" });
</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · InverseArena Docs</title>
<link rel="stylesheet" href="${prefix}assets/styles.css">
<script type="module" src="${prefix}assets/search.js"></script>
</head>
<body>
<div class="layout">
${renderNav(sections, prefix, slug)}
<main class="content">
<p class="source">Source: <code>${escapeHtml(sourcePath)}</code></p>
${body}
</main>
</div>
${mermaid}
</body>
</html>
`;
}

function renderHome(sections, dataFiles) {
  const groups = sections
    .map((section) => {
      const links = section.items
        .map(
          (item) =>
            `<li><a href="./pages/${escapeHtml(item.slug)}.html">${escapeHtml(item.title)}</a> <span class="source">${escapeHtml(item.sourcePath)}</span></li>`,
        )
        .join("\n");
      return `<section><h2>${escapeHtml(section.label)}</h2><ul>\n${links}\n</ul></section>`;
    })
    .join("\n");

  const assets = dataFiles
    .map((file) => `<li><a href="./data/${escapeHtml(file)}">${escapeHtml(file)}</a></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InverseArena Docs</title>
<link rel="stylesheet" href="./assets/styles.css">
<script type="module" src="./assets/search.js"></script>
</head>
<body>
<div class="layout">
${renderNav(sections, "./", "")}
<main class="content">
<h1>InverseArena documentation portal</h1>
<p>Documentation is generated directly from the repository Markdown sources. Generated API and contract data is copied below.</p>
<h2>Generated data</h2>
<ul>
${assets || "<li>No generated data assets found. Run the generators first.</li>"}
</ul>
<h2>All documents</h2>
${groups}
</main>
</div>
</body>
</html>
`;
}

function listGeneratedData(dataDir) {
  if (!existsSync(dataDir)) return [];

  const files = [];

  const walk = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relativePath);
      if (entry.isFile()) files.push(relativePath);
    }
  };

  walk(dataDir);
  return files.sort();
}

export function buildSite({ rootDir = repoRoot, outDir = join(portalDir, "dist") } = {}) {
  const sources = collectMarkdownSources(rootDir);
  const sections = buildNav(sources);
  assertNavIntegrity(sources, sections);

  const dataDir = join(portalDir, "data");
  const dataFiles = listGeneratedData(dataDir);
  const searchIndex = sources.map((source) => {
    const markdown = readFileSync(join(rootDir, source.sourcePath), "utf8");
    return {
      slug: source.slug,
      title: source.title,
      area: source.areaLabel,
      sourcePath: source.sourcePath,
      text: plainText(stripIgnoredSections(markdown)).replace(/\s+/g, " ").slice(0, 4000),
    };
  });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "pages"), { recursive: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });
  writeFileSync(join(outDir, "assets", "styles.css"), styles);
  writeFileSync(join(outDir, "assets", "search.js"), searchScript);
  writeFileSync(join(outDir, "search-index.json"), `${JSON.stringify(searchIndex, null, 2)}\n`);

  for (const source of sources) {
    const markdown = readFileSync(join(rootDir, source.sourcePath), "utf8");
    const body = renderMarkdown(rewriteGeneratedDataLinks(markdown, source.sourcePath, rootDir));
    const html = renderPage({
      title: source.title,
      body,
      sourcePath: source.sourcePath,
      sections,
      slug: source.slug,
      prefix: "../",
      hasMermaidBlock: hasMermaid(markdown),
    });
    writeFileSync(join(outDir, "pages", `${source.slug}.html`), html);
  }

  writeFileSync(join(outDir, "index.html"), renderHome(sections, dataFiles));

  if (existsSync(dataDir)) {
    cpSync(dataDir, join(outDir, "data"), { recursive: true });
  }

  return { sources, sections, outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = buildSite();
  console.log(`Built ${result.sources.length} pages in ${result.outDir}`);
}
