import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from "util";

if (!global.TextEncoder) {
  // Needed by stellar-sdk in the Jest/node environment.
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
}

if (!global.TextDecoder) {
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}
