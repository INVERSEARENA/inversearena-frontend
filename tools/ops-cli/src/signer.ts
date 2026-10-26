/**
 * Transaction signers. A secret never appears on the command line (it would
 * land in shell history and `ps`), in output, or in an error message:
 *
 *   --signer env:OPS_SECRET     secret seed read from that environment variable
 *   --signer file:./ops.key     secret seed read from a file only its owner can read
 *   --signer ledger[:N]         Ledger hardware wallet, account index N (default 0)
 */
import { statSync, readFileSync } from "node:fs";
import { Keypair, StrKey, type Transaction } from "@stellar/stellar-sdk";

export interface Signer {
  /** Safe to print: names the source, never the secret. */
  readonly description: string;
  publicKey(): Promise<string>;
  sign(tx: Transaction): Promise<void>;
}

export class SignerError extends Error {
  override name = "SignerError";
}

function keypairFromSecret(secret: string, origin: string): Keypair {
  const trimmed = secret.trim();
  if (!StrKey.isValidEd25519SecretSeed(trimmed)) {
    // Deliberately says nothing about the value itself.
    throw new SignerError(`${origin} does not hold a valid Stellar secret seed (S...)`);
  }
  return Keypair.fromSecret(trimmed);
}

function keypairSigner(keypair: Keypair, description: string): Signer {
  return {
    description,
    publicKey: async () => keypair.publicKey(),
    sign: async (tx) => tx.sign(keypair),
  };
}

export function envSigner(name: string, env: NodeJS.ProcessEnv = process.env): Signer {
  const secret = env[name];
  if (!secret) throw new SignerError(`Environment variable ${name} is not set`);
  return keypairSigner(keypairFromSecret(secret, `Environment variable ${name}`), `key from $${name}`);
}

export function fileSigner(path: string): Signer {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new SignerError(`Cannot read key file ${path}`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new SignerError(`Key file ${path} is readable by other users; run \`chmod 600 ${path}\``);
  }
  return keypairSigner(keypairFromSecret(readFileSync(path, "utf8"), `Key file ${path}`), `key from ${path}`);
}

/**
 * Ledger signer. The transport packages carry native USB bindings, so they
 * are optional: installed only by operators who use a hardware wallet.
 */
export function ledgerSigner(account: number): Signer {
  const path = `44'/148'/${account}'`;
  let connected: Promise<{ publicKey: string; signHash: (base: Buffer) => Promise<Buffer> }> | undefined;
  const connect = () =>
    (connected ??= (async () => {
      let Transport: any;
      let Str: any;
      try {
        const transportPkg = "@ledgerhq/hw-transport-node-hid";
        const appPkg = "@ledgerhq/hw-app-str";
        Transport = (await import(transportPkg)).default;
        Str = (await import(appPkg)).default;
      } catch {
        throw new SignerError(
          "Ledger support needs `npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str` in tools/ops-cli",
        );
      }
      const app = new Str(await Transport.create());
      const { rawPublicKey } = await app.getPublicKey(path);
      return {
        publicKey: StrKey.encodeEd25519PublicKey(rawPublicKey),
        signHash: async (base: Buffer) => (await app.signTransaction(path, base)).signature as Buffer,
      };
    })());
  return {
    description: `Ledger ${path}`,
    publicKey: async () => (await connect()).publicKey,
    async sign(tx) {
      const ledger = await connect();
      // The device shows and signs the transaction body; confirm it on screen.
      const signature = await ledger.signHash(tx.signatureBase());
      tx.addSignature(ledger.publicKey, signature.toString("base64"));
    },
  };
}

export function parseSigner(spec: string, env: NodeJS.ProcessEnv = process.env): Signer {
  const [kind, ...rest] = spec.split(":");
  const arg = rest.join(":");
  switch (kind) {
    case "env":
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) throw new SignerError("--signer env:<VARIABLE_NAME>");
      return envSigner(arg, env);
    case "file":
      if (!arg) throw new SignerError("--signer file:<path>");
      return fileSigner(arg);
    case "ledger": {
      const account = arg === "" ? 0 : Number(arg);
      if (!Number.isInteger(account) || account < 0) throw new SignerError("--signer ledger[:<account index>]");
      return ledgerSigner(account);
    }
    default:
      if (StrKey.isValidEd25519SecretSeed(spec.trim())) {
        throw new SignerError("Never pass a secret seed on the command line. Use --signer env:<VAR> or --signer file:<path>.");
      }
      throw new SignerError(`Unknown signer "${kind}". Use env:<VAR>, file:<path> or ledger[:<index>].`);
  }
}
