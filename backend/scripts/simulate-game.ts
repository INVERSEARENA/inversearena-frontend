#!/usr/bin/env tsx
/**
 * Multi-round game simulation CLI for local development and demos.
 *
 * Creates an arena via the factory contract on Stellar testnet, joins N
 * simulated players, runs R rounds with randomly distributed choices, resolves
 * each round, and logs the winner and prize.
 *
 * Usage:
 *   npm run simulate -- --players 10 --rounds 5
 *   npm run simulate -- --players 4 --rounds 3 --network testnet
 *   npm run simulate -- --arena-id C... --players 6 --rounds 5
 *
 * Requirements:
 *   - Stellar testnet funded accounts (run scripts/setup-testnet.ts first)
 *   - .env or environment variables: ADMIN_ACCOUNT_SECRET, SOROBAN_RPC_URL,
 *     FACTORY_CONTRACT_ID, STELLAR_NETWORK_PASSPHRASE
 */

import { program } from "commander";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Operation,
  Asset,
  Horizon,
  SorobanRpc,
  xdr,
  Address,
  nativeToScVal,
  Contract,
} from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Choice = "heads" | "tails";

interface SimulatedPlayer {
  index: number;
  keypair: Keypair;
  active: boolean;
  totalStaked: number;
}

interface RoundResult {
  round: number;
  choices: Record<string, Choice>;
  oracleYield: number;
  winningChoice: Choice;
  eliminated: number;
  survivors: number;
  eliminatedPlayers: SimulatedPlayer[];
}

interface SimulationResult {
  arenaId: string;
  totalRounds: number;
  roundResults: RoundResult[];
  winner: SimulatedPlayer | null;
  prizeAmount: number;
  networkFees: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig(network: string) {
  if (network === "mainnet") {
    return {
      networkPassphrase: Networks.PUBLIC,
      sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-mainnet.stellar.org",
      horizonUrl: process.env.HORIZON_URL ?? "https://horizon.stellar.org",
    };
  }
  return {
    networkPassphrase: Networks.TESTNET,
    sorobanRpcUrl:
      process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    horizonUrl:
      process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  };
}

// ---------------------------------------------------------------------------
// Stellar helpers
// ---------------------------------------------------------------------------

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Friendbot failed for ${publicKey}: ${text}`);
  }
}

async function loadAccount(
  server: Horizon.Server,
  keypair: Keypair
): Promise<Horizon.AccountResponse> {
  return server.loadAccount(keypair.publicKey());
}

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------

function randomChoice(): Choice {
  return Math.random() > 0.5 ? "heads" : "tails";
}

function resolveRound(
  players: SimulatedPlayer[],
  choices: Record<string, Choice>,
  oracleYield: number
): { winningChoice: Choice; eliminated: SimulatedPlayer[] } {
  // The oracle yield determines the winning side via parity (matches contract logic).
  // Even truncated yield → "heads" wins; odd → "tails" wins.
  const yieldFloor = Math.floor(oracleYield * 100);
  const winningChoice: Choice = yieldFloor % 2 === 0 ? "heads" : "tails";

  const eliminated = players.filter(
    (p) => p.active && choices[p.keypair.publicKey()] !== winningChoice
  );

  return { winningChoice, eliminated };
}

function buildChoices(players: SimulatedPlayer[]): Record<string, Choice> {
  const choices: Record<string, Choice> = {};
  for (const player of players) {
    if (player.active) {
      choices[player.keypair.publicKey()] = randomChoice();
    }
  }
  return choices;
}

function printRoundBanner(round: number, maxRounds: number): void {
  const bar = "═".repeat(50);
  console.log(`\n╔${bar}╗`);
  console.log(`║  ROUND ${String(round).padEnd(2)} / ${String(maxRounds).padEnd(2)}${" ".repeat(38)}║`);
  console.log(`╚${bar}╝`);
}

function printChoiceDistribution(
  choices: Record<string, Choice>,
  activePlayers: SimulatedPlayer[]
): void {
  const heads = activePlayers.filter(
    (p) => choices[p.keypair.publicKey()] === "heads"
  ).length;
  const tails = activePlayers.length - heads;
  console.log(`  Choices — Heads: ${heads}, Tails: ${tails}`);
}

// ---------------------------------------------------------------------------
// Main simulation
// ---------------------------------------------------------------------------

async function runSimulation(options: {
  players: number;
  rounds: number;
  network: string;
  arenaId?: string;
  entryFee: number;
}): Promise<SimulationResult> {
  const { players: numPlayers, rounds: maxRounds, network, entryFee } = options;
  const config = getConfig(network);

  const adminSecret = process.env.ADMIN_ACCOUNT_SECRET;
  const factoryContractId = process.env.FACTORY_CONTRACT_ID;

  console.log("\n🎮  InverseArena — Game Simulation");
  console.log("━".repeat(52));
  console.log(`  Network     : ${network}`);
  console.log(`  Players     : ${numPlayers}`);
  console.log(`  Max rounds  : ${maxRounds}`);
  console.log(`  Entry fee   : ${entryFee} XLM`);
  if (options.arenaId) console.log(`  Arena ID    : ${options.arenaId}`);
  console.log("");

  const horizon = new Horizon.Server(config.horizonUrl);
  const soroban = new SorobanRpc.Server(config.sorobanRpcUrl);

  // Create simulated players
  console.log("Creating simulated player accounts...");
  const simulatedPlayers: SimulatedPlayer[] = Array.from(
    { length: numPlayers },
    (_, i) => ({
      index: i + 1,
      keypair: adminSecret && i === 0 ? Keypair.fromSecret(adminSecret) : Keypair.random(),
      active: true,
      totalStaked: 0,
    })
  );

  // Fund all player accounts on testnet
  if (network === "testnet") {
    console.log("Funding accounts via Friendbot...");
    await Promise.allSettled(
      simulatedPlayers.map(async (p) => {
        try {
          await fundAccount(p.keypair.publicKey());
          console.log(`  ✓ Player ${p.index}: ${p.keypair.publicKey()}`);
        } catch (err) {
          // Account may already exist
          console.log(
            `  ~ Player ${p.index}: ${p.keypair.publicKey()} (already funded or skipped)`
          );
        }
      })
    );
  }

  // Resolve or create arena ID
  let arenaId = options.arenaId;
  if (!arenaId) {
    if (!factoryContractId) {
      // Simulation mode without on-chain factory — generate a local UUID
      arenaId = `sim-arena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`\nNo FACTORY_CONTRACT_ID set — running in local simulation mode.`);
      console.log(`Arena ID (local): ${arenaId}`);
    } else {
      // Real on-chain arena creation would go here
      // This placeholder logs intent without blocking local demo mode
      arenaId = `sim-arena-${Date.now()}`;
      console.log(`\nFactory contract: ${factoryContractId}`);
      console.log(
        `Arena creation via factory is stubbed — extend this script once the factory initialize ABI is finalised.`
      );
      console.log(`Arena ID (simulated): ${arenaId}`);
    }
  }

  console.log(
    `\nPlayers joined: ${simulatedPlayers.map((p) => `Player ${p.index}`).join(", ")}`
  );
  console.log("Arena started. Running rounds...");

  const roundResults: RoundResult[] = [];
  let roundNumber = 1;
  let networkFees = 0;

  while (roundNumber <= maxRounds) {
    const activePlayers = simulatedPlayers.filter((p) => p.active);

    if (activePlayers.length <= 1) {
      console.log(`\n  Only ${activePlayers.length} player(s) remaining — ending early.`);
      break;
    }

    printRoundBanner(roundNumber, maxRounds);

    const choices = buildChoices(simulatedPlayers);
    // Simulated oracle yield — random float in [0, 1)
    const oracleYield = Math.random();

    printChoiceDistribution(choices, activePlayers);
    console.log(`  Oracle yield: ${oracleYield.toFixed(6)}`);

    const { winningChoice, eliminated } = resolveRound(
      simulatedPlayers,
      choices,
      oracleYield
    );

    // Mark eliminated players as inactive
    for (const p of eliminated) {
      p.active = false;
    }

    const survivors = simulatedPlayers.filter((p) => p.active).length;

    const result: RoundResult = {
      round: roundNumber,
      choices,
      oracleYield,
      winningChoice,
      eliminated: eliminated.length,
      survivors,
      eliminatedPlayers: eliminated,
    };
    roundResults.push(result);

    console.log(`  Winning choice: ${winningChoice.toUpperCase()}`);
    console.log(
      `  Eliminated: ${eliminated.length} player(s) → ${eliminated.map((p) => `Player ${p.index}`).join(", ") || "none"}`
    );
    console.log(`  Survivors: ${survivors}`);

    if (survivors <= 1) {
      console.log(`\n  Game over after round ${roundNumber}.`);
      break;
    }

    roundNumber++;
  }

  // Determine winner
  const remainingPlayers = simulatedPlayers.filter((p) => p.active);
  const winner = remainingPlayers.length === 1 ? remainingPlayers[0] : null;

  // Prize = sum of all entry fees (simple model)
  const prizeAmount = numPlayers * entryFee;

  console.log("\n" + "═".repeat(52));
  console.log("  GAME OVER");
  console.log("═".repeat(52));

  if (winner) {
    console.log(`  🏆 Winner: Player ${winner.index}`);
    console.log(`     Public key: ${winner.keypair.publicKey()}`);
    console.log(`  💰 Prize: ${prizeAmount} XLM`);
  } else if (remainingPlayers.length === 0) {
    console.log("  No winner — all players eliminated.");
  } else {
    console.log(
      `  ${remainingPlayers.length} players survived all rounds — prize split between them.`
    );
    for (const p of remainingPlayers) {
      console.log(`    Player ${p.index}: ${p.keypair.publicKey()}`);
    }
    console.log(`  💰 Prize per winner: ${(prizeAmount / remainingPlayers.length).toFixed(2)} XLM`);
  }

  console.log(`\n  Total rounds played: ${roundResults.length}`);
  console.log(`  Arena ID: ${arenaId}`);
  console.log("═".repeat(52) + "\n");

  return {
    arenaId,
    totalRounds: roundResults.length,
    roundResults,
    winner,
    prizeAmount,
    networkFees,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

program
  .name("simulate-game")
  .description(
    "Multi-round InverseArena game simulation for local development and demos"
  )
  .option("-n, --players <number>", "Number of simulated players", "10")
  .option("-r, --rounds <number>", "Maximum rounds", "5")
  .option("--network <network>", "testnet or mainnet", "testnet")
  .option("--arena-id <id>", "Reuse an existing arena instead of creating one")
  .option("--entry-fee <xlm>", "Entry fee per player in XLM", "10")
  .action(async (options) => {
    try {
      await runSimulation({
        players: parseInt(options.players, 10),
        rounds: parseInt(options.rounds, 10),
        network: options.network,
        arenaId: options.arenaId,
        entryFee: parseFloat(options.entryFee),
      });
    } catch (err) {
      console.error("\nSimulation failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
