import fs from "fs";
import path from "path";

describe("PWA manifest (#691)", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/manifest.json"), "utf8"),
  );

  it("declares an installable standalone app", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("provides 192px and 512px icons", () => {
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
});
