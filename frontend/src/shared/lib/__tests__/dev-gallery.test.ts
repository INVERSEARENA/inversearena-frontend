/**
 * Dev-gallery gate tests (#1645).
 *
 * Production builds must 404 every `/dev` path so demo routes never ship.
 */
import { isDevGalleryEnabled, isDevGalleryPath } from "../dev-gallery";

describe("isDevGalleryEnabled (#1645)", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY;
    } else {
      process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY = ORIGINAL_FLAG;
    }
  });

  it("is enabled outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY;
    expect(isDevGalleryEnabled()).toBe(true);
  });

  it("is disabled in production by default", () => {
    process.env.NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY;
    expect(isDevGalleryEnabled()).toBe(false);
  });

  it("can be opened on a production build via the explicit flag", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY = "1";
    expect(isDevGalleryEnabled()).toBe(true);
  });
});

describe("isDevGalleryPath (#1645)", () => {
  it("matches the gallery root and nested routes", () => {
    expect(isDevGalleryPath("/dev")).toBe(true);
    expect(isDevGalleryPath("/dev/choice-cards")).toBe(true);
    expect(isDevGalleryPath("/dev/modals")).toBe(true);
  });

  it("does not match production routes", () => {
    expect(isDevGalleryPath("/")).toBe(false);
    expect(isDevGalleryPath("/dashboard")).toBe(false);
    expect(isDevGalleryPath("/arena")).toBe(false);
    // A prefix match must not catch /device or similar.
    expect(isDevGalleryPath("/device")).toBe(false);
  });
});
