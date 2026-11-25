import assert from "node:assert/strict";
import test from "node:test";
import {
  extractHeadings,
  hasMermaid,
  renderInline,
  renderMarkdown,
  stripIgnoredSections,
} from "./markdown.mjs";

test("escapes raw html and renders headings", () => {
  const html = renderMarkdown("# Hello & welcome\n\n<script>alert(1)</script>");
  assert.match(html, /<h1 id="hello-welcome">Hello &amp; welcome<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("renders inline code and links", () => {
  const html = renderInline("See `event-schema.md` and [the guide](./guide.md#intro).");
  assert.match(html, /<code>event-schema\.md<\/code>/);
  assert.match(html, /<a href="\.\/guide\.md#intro">the guide<\/a>/);
});

test("renders fenced code blocks with escaped content", () => {
  const html = renderMarkdown("```js\nconst value = \"<b>\";\n```");
  assert.match(html, /<pre><code class="language-js">const value = &quot;&lt;b&gt;&quot;;/);
});

test("preserves mermaid fenced blocks", () => {
  const markdown = "```mermaid\ngraph TD;\n A-->B;\n```";
  const html = renderMarkdown(markdown);
  assert.match(html, /<pre class="language-mermaid">graph TD;\n A--&gt;B;<\/pre>/);
  assert.equal(hasMermaid(markdown), true);
  assert.equal(hasMermaid("# No diagram"), false);
});

test("renders lists", () => {
  const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
});

test("extracts headings and handles duplicate anchors", () => {
  const headings = extractHeadings("# Same\n\n## Same\n\n# Same");
  assert.deepEqual(
    headings.map((heading) => heading.slug),
    ["same", "same-1", "same-2"],
  );
});

test("strips code fences and html comments before scanning", () => {
  const stripped = stripIgnoredSections(
    "# Keep\n<!-- [comment](./missing.md) -->\n```\n[fence](./missing.md)\n```\n[real](./ok.md)",
  );
  assert.match(stripped, /# Keep/);
  assert.match(stripped, /\[real\]\(\.\/ok\.md\)/);
  assert.doesNotMatch(stripped, /comment/);
  assert.doesNotMatch(stripped, /fence/);
});
