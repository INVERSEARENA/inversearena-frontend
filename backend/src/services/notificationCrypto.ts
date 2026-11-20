import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../config/env";

const PREFIX = "v1";

function keyFromEnv(): Buffer {
  const raw = env.PUSH_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("PUSH_ENCRYPTION_KEY must be 32 random bytes as 64 hex characters");
  }
  return Buffer.from(raw, "hex");
}

/**
 * AES-256-GCM at-rest encryption for notification secrets that are not Web
 * Push keys (currently community webhook URLs). Uses the same operational key
 * as Web Push so deployments only need one rotation procedure.
 */
export class NotificationCrypto {
  constructor(private readonly key?: Buffer) {}

  private requireKey(): Buffer {
    return this.key ?? keyFromEnv();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      PREFIX,
      iv.toString("base64"),
      ciphertext.toString("base64"),
      cipher.getAuthTag().toString("base64"),
    ].join(":");
  }

  decrypt(payload: string): string {
    const [prefix, ivB64, ctB64, tagB64] = payload.split(":");
    if (prefix !== PREFIX || !ivB64 || !ctB64 || !tagB64) {
      throw new Error("Unrecognized encrypted notification field format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.requireKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return decipher.update(Buffer.from(ctB64, "base64"), undefined, "utf8") + decipher.final("utf8");
  }
}
