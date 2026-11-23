/**
 * Mainnet safety: submitting on mainnet needs an explicit confirmation, either
 * typed at an interactive prompt or passed as --confirm-mainnet for scripted
 * runs. Without a terminal and without the flag, nothing is sent.
 */
import { createInterface } from "node:readline/promises";
import type { NetworkName } from "./manifest.js";

export class SafetyError extends Error {
  override name = "SafetyError";
}

export interface ConfirmOptions {
  network: NetworkName;
  /** What is about to happen, e.g. "resolve_round on CABC…". */
  action: string;
  confirmFlag: boolean;
  interactive: boolean;
  ask?: (question: string) => Promise<string>;
}

async function askOnTty(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirmSubmit({ network, action, confirmFlag, interactive, ask = askOnTty }: ConfirmOptions): Promise<void> {
  if (network !== "mainnet" || confirmFlag) return;
  if (!interactive) {
    throw new SafetyError(`Refusing to submit ${action} on MAINNET without a terminal. Pass --confirm-mainnet to proceed.`);
  }
  const answer = await ask(`About to submit ${action} on MAINNET. Type "mainnet" to continue: `);
  if (answer.trim() !== "mainnet") throw new SafetyError("Mainnet submission cancelled");
}
