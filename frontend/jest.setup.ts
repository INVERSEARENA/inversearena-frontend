import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from "util";

process.env.NEXT_PUBLIC_STELLAR_NETWORK ??= "testnet";
process.env.NEXT_PUBLIC_HORIZON_URL ??= "https://horizon-testnet.stellar.org";
process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID ??=
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ??=
  "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

if (!global.TextEncoder) {
  // Needed by stellar-sdk in the Jest/node environment.
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
}

if (!global.TextDecoder) {
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}
