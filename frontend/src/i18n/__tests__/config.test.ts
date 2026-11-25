import {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  negotiateLocale,
  resolveLocale,
} from "../config";

describe("i18n config (#1575)", () => {
  it("exposes en and es as the supported locales", () => {
    expect(LOCALES).toEqual(["en", "es"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  describe("isLocale", () => {
    it("accepts supported locales only", () => {
      expect(isLocale("en")).toBe(true);
      expect(isLocale("es")).toBe(true);
      expect(isLocale("de")).toBe(false);
      expect(isLocale(null)).toBe(false);
      expect(isLocale(42)).toBe(false);
    });
  });

  describe("negotiateLocale", () => {
    it("defaults when the header is missing", () => {
      expect(negotiateLocale(undefined)).toBe("en");
      expect(negotiateLocale(null)).toBe("en");
      expect(negotiateLocale("")).toBe("en");
    });

    it("honours q-values and picks the best supported candidate", () => {
      expect(negotiateLocale("es-ES,es;q=0.9,en;q=0.8")).toBe("es");
      expect(negotiateLocale("en-US,en;q=0.9,es;q=0.8")).toBe("en");
      expect(negotiateLocale("es;q=0.2,de;q=0.9")).toBe("es");
    });

    it("falls back to the default for unsupported languages", () => {
      expect(negotiateLocale("fr-FR,fr;q=0.9")).toBe("en");
      expect(negotiateLocale("de")).toBe("en");
      expect(negotiateLocale("*,;q=1")).toBe("en");
    });

    it("matches region subtags on their base language", () => {
      expect(negotiateLocale("es-MX")).toBe("es");
      expect(negotiateLocale("en-GB")).toBe("en");
    });
  });

  describe("resolveLocale", () => {
    it("prefers a valid cookie over the header", () => {
      expect(resolveLocale("es", "en-US,en;q=0.9")).toBe("es");
      expect(resolveLocale("en", "es")).toBe("en");
    });

    it("ignores an invalid cookie and falls back to the header", () => {
      expect(resolveLocale("de", "es-ES")).toBe("es");
      expect(resolveLocale(undefined, "es")).toBe("es");
      expect(resolveLocale(null, null)).toBe("en");
      expect(resolveLocale("", "fr")).toBe("en");
    });
  });
});
