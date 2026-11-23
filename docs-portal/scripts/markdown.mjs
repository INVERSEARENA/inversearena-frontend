export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripFencedCode(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let fence = null;

  for (const line of lines) {
    if (fence) {
      output.push("");
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }

    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      fence = match[1][0].repeat(match[1].length);
      output.push("");
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

export function stripIgnoredSections(markdown) {
  return stripFencedCode(String(markdown).replace(/<!--[\s\S]*?-->/g, ""));
}

export function githubSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function plainText(markdown) {
  return String(markdown)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .trim();
}

export function extractHeadings(markdown) {
  const headings = [];
  const counts = new Map();

  for (const line of stripIgnoredSections(markdown).split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const text = plainText(match[2]);
    const base = githubSlug(text);
    if (!base) continue;

    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({
      level: match[1].length,
      text,
      slug: count === 0 ? base : `${base}-${count}`,
    });
  }

  return headings;
}

export function hasMermaid(markdown) {
  return /^\s*(```|~~~)\s*mermaid\b/im.test(String(markdown));
}

export function extractTitle(markdown, fallback = "Untitled") {
  return extractHeadings(markdown).find((heading) => heading.level === 1)?.text ?? fallback;
}

export function titleFromPath(sourcePath) {
  const base = sourcePath.split(/[\\/]/).pop().replace(/\.md$/i, "");
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeHref(href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(https?:|mailto:)/i.test(href)) return null;
  return href;
}

export function renderInline(markdown) {
  const codeSpans = [];
  let html = escapeHtml(markdown);

  html = html.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  html = html.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, label, href) => {
    const target = safeHref(href);
    if (!target) return label;
    return `<a href="${target}">${label}</a>`;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
}

export function renderMarkdown(markdown) {
  const source = String(markdown).replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = source.split("\n");
  const headings = extractHeadings(source);
  let headingIndex = 0;
  const html = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const marker = fence[1][0].repeat(fence[1].length);
      const language = fence[2];
      const body = [];
      index += 1;

      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }

      const content = escapeHtml(body.join("\n"));
      if (language === "mermaid") {
        html.push(`<pre class="language-mermaid">${content}</pre>`);
      } else {
        const className = language ? ` class="language-${escapeHtml(language)}"` : "";
        html.push(`<pre><code${className}>${content}</code></pre>`);
      }
      continue;
    }

    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const id = headings[headingIndex++]?.slug ?? githubSlug(plainText(heading[2]));
      html.push(`<h${heading[1].length} id="${escapeHtml(id)}">${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const tag = ordered ? "ol" : "ul";
      if (list !== tag) {
        flushList();
        html.push(`<${tag}>`);
        list = tag;
      }
      html.push(`<li>${renderInline((ordered ?? unordered)[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line.replace(/^>\s?/, ""));
  }

  flush();
  return html.join("\n");
}
