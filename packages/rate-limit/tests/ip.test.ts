import { resolveClientIp, UNTRUSTED_CLIENT_BUCKET } from "../src/ip";

describe("IP Resolution behind N trusted proxies", () => {
  const originalEnv = process.env.TRUSTED_PROXY_COUNT;

  afterEach(() => {
    process.env.TRUSTED_PROXY_COUNT = originalEnv;
  });

  describe("when trustedProxyCount is 0 (direct / untrusted)", () => {
    it("fails closed to unknown bucket regardless of headers", () => {
      const headers = {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18",
        "x-real-ip": "203.0.113.195",
      };

      expect(resolveClientIp(headers, 0)).toBe(UNTRUSTED_CLIENT_BUCKET);
    });

    it("fails closed when using header getter interface", () => {
      const getter = {
        get(name: string) {
          if (name.toLowerCase() === "x-forwarded-for") return "1.2.3.4";
          return null;
        },
      };

      expect(resolveClientIp(getter, 0)).toBe("unknown");
    });
  });

  describe("when trustedProxyCount is 1 (e.g., single reverse proxy / CDN)", () => {
    it("extracts the right-most IP before our proxy", () => {
      const headers = {
        "x-forwarded-for": "203.0.113.195",
      };

      expect(resolveClientIp(headers, 1)).toBe("203.0.113.195");
    });

    it("ignores spoofed client-prepended IPs", () => {
      // Attacker sends X-Forwarded-For: 8.8.8.8; our ingress appends 203.0.113.195
      const headers = {
        "x-forwarded-for": "8.8.8.8, 203.0.113.195",
      };

      expect(resolveClientIp(headers, 1)).toBe("203.0.113.195");
    });

    it("falls back to X-Real-IP if X-Forwarded-For is missing", () => {
      const headers = {
        "x-real-ip": "198.51.100.4",
      };

      expect(resolveClientIp(headers, 1)).toBe("198.51.100.4");
    });
  });

  describe("when trustedProxyCount is 2 (e.g. Cloudflare CDN + ALB/Nginx ingress)", () => {
    it("extracts client IP from parts.length - 2", () => {
      // Chain: Client (198.51.100.55) -> Cloudflare (172.68.1.1) -> ALB (10.0.0.1) -> App
      const headers = {
        "x-forwarded-for": "198.51.100.55, 172.68.1.1, 10.0.0.1",
      };

      expect(resolveClientIp(headers, 2)).toBe("172.68.1.1");
    });

    it("ignores attacker spoofing multiple IPs on the left", () => {
      const headers = {
        "x-forwarded-for": "spoofed1, spoofed2, 198.51.100.55, 172.68.1.1, 10.0.0.1",
      };

      // length = 5, trusted = 2 -> index = 5 - 2 = 3 -> 172.68.1.1
      expect(resolveClientIp(headers, 2)).toBe("172.68.1.1");
    });

    it("returns untrusted bucket if header has fewer entries than trusted proxy count", () => {
      const headers = {
        "x-forwarded-for": "10.0.0.1",
      };

      expect(resolveClientIp(headers, 2)).toBe(UNTRUSTED_CLIENT_BUCKET);
    });
  });

  describe("when trustedProxyCount is N (arbitrary depth)", () => {
    it("consistently selects parts.length - N", () => {
      const ips = ["attacker", "client-ip", "proxy1", "proxy2", "proxy3"];
      const headers = {
        "x-forwarded-for": ips.join(", "),
      };

      expect(resolveClientIp(headers, 3)).toBe("proxy1");
      expect(resolveClientIp(headers, 4)).toBe("client-ip");
    });
  });
});
