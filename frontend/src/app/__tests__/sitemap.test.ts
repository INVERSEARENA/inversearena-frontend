import sitemap, { SITE_URL } from "../sitemap";
import fs from "fs";
import path from "path";

describe("sitemap (#699)", () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it("includes the public landing and leaderboard pages", () => {
    expect(urls).toContain(`${SITE_URL}/`);
    expect(urls).toContain(`${SITE_URL}/leaderboard`);
  });

  it("does not expose authenticated/in-game routes", () => {
    expect(urls.some((u) => u.includes("/dashboard"))).toBe(false);
    expect(urls.some((u) => u.includes("/arena/"))).toBe(false);
  });
});

describe("robots.txt (#699)", () => {
  const robots = fs.readFileSync(path.join(process.cwd(), "public/robots.txt"), "utf8");

  it("disallows dashboard and in-game arena routes", () => {
    expect(robots).toMatch(/Disallow:\s*\/dashboard/);
    expect(robots).toMatch(/Disallow:\s*\/arena\//);
  });

  it("references the sitemap", () => {
    expect(robots).toMatch(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/);
  });
});
