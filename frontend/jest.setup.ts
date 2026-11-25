import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from "util";
import { webcrypto } from "node:crypto";

process.env.NEXT_PUBLIC_STELLAR_NETWORK ??= "testnet";
process.env.NEXT_PUBLIC_HORIZON_URL ??= "https://horizon-testnet.stellar.org";
process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID ??=
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ??=
  "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID ??=
  "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
process.env.NEXT_PUBLIC_ORACLE_CONTRACT_ID ??=
  "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

if (!global.TextEncoder) {
  // Needed by stellar-sdk in the Jest/node environment.
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
}

if (!global.TextDecoder) {
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}

if (!global.crypto?.subtle) {
  // jsdom's crypto has getRandomValues but no SubtleCrypto; needed for
  // commit-reveal's in-browser SHA-256 hashing (#1137).
  Object.defineProperty(global, "crypto", { value: webcrypto, configurable: true });
}

if (typeof Response === "undefined") {
  class MockResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly headers: Headers;
    private readonly _body: string;

    constructor(body?: string | null, init?: ResponseInit) {
      this._body = typeof body === "string" ? body : "";
      this.status = init?.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(init?.headers);
    }

    async json() {
      return this._body ? JSON.parse(this._body) : null;
    }

    async text() {
      return this._body;
    }
  }

  // @ts-expect-error MockResponse polyfill for jsdom environment
  global.Response = MockResponse;
  // @ts-expect-error MockResponse polyfill for jsdom environment
  window.Response = MockResponse;
}
