import { YieldSnapshot } from "./arenaTypes";

/**
 * Constants for time calculations
 */
const SECONDS_IN_YEAR = 31536000; // 365 * 24 * 60 * 60
const SECONDS_IN_DAY = 86400; // 24 * 60 * 60

/**
 * Calculates the accrued yield for a given principal and APY over a specific duration.
 * Uses linear (simple) yield calculation for the prorated period.
 * 
 * @param principal - The initial amount of assets
 * @param apy - The Annual Percentage Yield (e.g., 0.05 for 5%)
 * @param elapsedSeconds - The time elapsed in seconds
 * @returns The amount of yield accrued during the period
 */
export function calculateAccruedYield(
    principal: number,
    apy: number,
    elapsedSeconds: number
): number {
    if (principal <= 0 || apy <= 0 || elapsedSeconds <= 0) {
        return 0;
    }

    // Formula: Yield = Principal * APY * (Time / Year)
    return principal * apy * (elapsedSeconds / SECONDS_IN_YEAR);
}

/**
 * Applies a surge multiplier to a base yield amount.
 * 
 * @param baseYield - The initial yield amount before boost
 * @param multiplier - The surge multiplier (e.g., 2.0 for 2x boost)
 * @returns The boosted yield amount
 */
export function applySurgeMultiplier(
    baseYield: number,
    multiplier: number
): number {
    if (baseYield <= 0 || multiplier <= 0) {
        return Math.max(0, baseYield);
    }

    return baseYield * multiplier;
}

/**
 * Projects the future yield for a given principal and APY at a target time in the future.
 * 
 * @param principal - The current principal amount
 * @param apy - The Annual Percentage Yield
 * @param targetSeconds - The future time horizon in seconds
 * @returns The projected yield amount at the target time
 */
export function projectYieldAt(
    principal: number,
    apy: number,
    targetSeconds: number
): number {
    // Forward projection uses the same math as accrued yield calculation
    return calculateAccruedYield(principal, apy, targetSeconds);
}

/**
 * Calculates the percentage trend (change) in APY over the last 24-hour window.
 * 
 * @param history - Array of yield snapshots ordered by timestamp
 * @returns The percentage change in APY (e.g., 5.0 for a 5% increase in rate)
 */
export function calculateTrend(history: YieldSnapshot[]): number {
    if (history.length < 2) {
        return 0;
    }

    const latest = history[history.length - 1];
    const targetTime = latest.lastUpdatedAt - SECONDS_IN_DAY;

    // Find the snapshot closest to 24h ago
    // We look for the first snapshot that is at or before targetTime
    let pastSnapshot: YieldSnapshot | undefined;

    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].lastUpdatedAt <= targetTime) {
            pastSnapshot = history[i];
            break;
        }
    }

    // If no snapshot is old enough, use the oldest available
    if (!pastSnapshot) {
        pastSnapshot = history[0];
    }

    if (pastSnapshot.apy <= 0) {
        return latest.apy > 0 ? 100 : 0;
    }

    // Percentage change in APY: ((Current - Past) / Past) * 100
    const change = ((latest.apy - pastSnapshot.apy) / pastSnapshot.apy) * 100;

    return Number(change.toFixed(4));
}

/**
 * Estimates the total yield that will be added to the prize pool for a single round.
 * 
 * @param totalStake - The total assets staked in the arena
 * @param apy - The current base APY of the underlying RWA
 * @param roundDurationSeconds - The duration of the round in seconds
 * @returns The estimated yield to be added to the prize pot
 */
export function estimatePrizePoolYield(
    totalStake: number,
    apy: number,
    roundDurationSeconds: number
): number {
    return calculateAccruedYield(totalStake, apy, roundDurationSeconds);
}
