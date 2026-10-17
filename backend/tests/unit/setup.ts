import "dotenv/config";

process.env.JWT_SECRET = "super-secret-test-key-must-be-at-least-32-chars";
process.env.NONCE_TTL_SECONDS = "300";
process.env.ADMIN_API_KEY = "test-admin-key-at-least-32-chars-long";
process.env.ORACLE_WEBHOOK_SECRET = "test-oracle-webhook-secret";

process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_HORIZON_URL ??= "https://horizon-testnet.stellar.org";
process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID ??= "CAFACTORY000000000000000000000000000000000000001";
process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ??= "CAUSDC0000000000000000000000000000000000000002";
process.env.NEXT_PUBLIC_PASSKEY_DEMO_MODE ??= "true";
