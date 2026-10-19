/**
 * Unit-test setup (#1644). No external services — just environment defaults.
 * Integration suites use tests/setup/setup.ts, which boots MongoMemoryServer
 * and connects Postgres/Redis.
 */
import "dotenv/config";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "super-secret-test-key-must-be-at-least-32-chars";
process.env.NONCE_TTL_SECONDS = process.env.NONCE_TTL_SECONDS ?? "300";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key-at-least-32-chars-long";
process.env.ORACLE_WEBHOOK_SECRET = process.env.ORACLE_WEBHOOK_SECRET ?? "test-oracle-webhook-secret";
process.env.MONGOMS_MD5_CHECK = process.env.MONGOMS_MD5_CHECK ?? "0";
process.env.NEXT_PUBLIC_SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID ??
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.NEXT_PUBLIC_USDC_CONTRACT_ID =
  process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ??
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.TRUSTED_PROXY_COUNT = process.env.TRUSTED_PROXY_COUNT ?? "1";
