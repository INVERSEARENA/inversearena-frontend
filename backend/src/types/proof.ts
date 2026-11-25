/**
 * Round Proof Bundle and Dispute Evidence Types
 */

export interface ProofBundle {
  roundId: string;
  arenaId: string;
  roundNumber: number;
  bundleHash: string; // Content-addressed identifier
  generatedAt: Date;
  
  // Round data
  state: string;
  playerChoices: PlayerChoiceProof[];
  oracleYield: number;
  randomSeed: string;
  
  // Resolution proof
  resolution: {
    eliminatedPlayers: string[];
    payouts: PayoutProof[];
    poolBalances: Record<string, number>;
  };
  
  // Merkle proofs for verification
  merkleRoot: string;
  merkleProofs: Record<string, string[]>; // userId => proof path
  
  // Metadata
  blockHeight?: number;
  timestamp: Date;
  signature?: string;
}

export interface PlayerChoiceProof {
  userId: string;
  choice: string;
  stake: number;
  timestamp: Date;
  choiceHash: string;
}

export interface PayoutProof {
  userId: string;
  amount: number;
  reason: 'WIN' | 'SURVIVAL' | 'REFUND';
  transactionHash?: string;
}

export interface DisputeEvidence {
  roundId: string;
  userId: string;
  evidenceHash: string; // Content-addressed identifier
  generatedAt: Date;
  
  // Player-specific data
  playerChoice: PlayerChoiceProof;
  wasEliminated: boolean;
  payout?: PayoutProof;
  
  // Verification data
  merkleProof: string[];
  merkleRoot: string;
  
  // Context
  roundState: string;
  oracleYield: number;
  totalPlayers: number;
  eliminatedCount: number;
}

export interface ProofArtifact {
  hash: string;
  type: 'proof_bundle' | 'dispute_evidence';
  roundId: string;
  userId?: string; // For dispute evidence
  data: ProofBundle | DisputeEvidence;
  size: number;
  createdAt: Date;
  expiresAt?: Date;
}

export interface ProofGenerationJob {
  roundId: string;
  arenaId: string;
  roundNumber: number;
  trigger: 'settlement' | 'dispute' | 'manual';
  requestedAt: Date;
}

export interface ProofGenerationResult {
  roundId: string;
  bundleHash: string;
  evidenceHashes: Record<string, string>; // userId => evidenceHash
  generationTimeMs: number;
  artifactCount: number;
  totalSize: number;
}
