import type { CommitmentContext, RoundChoice } from "@/shared/lib/stellar/commit-reveal";

/** Request sent from the main thread to the commitment worker. */
export interface CommitmentRequestMessage {
  type: "computeCommitment";
  id: number;
  choice: RoundChoice;
  salt: Uint8Array;
  context: CommitmentContext;
}

/** Response from the commitment worker, correlated by `id`. */
export type CommitmentResponseMessage =
  | { type: "result"; id: number; digest: Uint8Array }
  | { type: "error"; id: number; message: string };
