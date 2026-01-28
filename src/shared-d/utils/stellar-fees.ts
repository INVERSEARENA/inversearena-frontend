/**
 * Stellar network fee estimation utilities
 */

export type Currency = "USDC" | "XLM";

/**
 * Base fee for a simple transaction (in stroops)
 * 1 XLM = 10,000,000 stroops
 */
const BASE_FEE_STROOPS = 100;

/**
 * Estimated fee for Soroban contract invocation (in stroops)
 * Complex contract calls typically cost more
 */
const SOROBAN_CONTRACT_FEE_STROOPS = 10000;

/**
 * Convert stroops to XLM
 */
function stroopsToXLM(stroops: number): number {
    return stroops / 10_000_000;
}

/**
 * Estimate network fee for pool creation transaction
 * Returns fee in XLM
 */
export function estimateCreatePoolFee(): number {
    // Pool creation involves:
    // 1. Contract invocation
    // 2. Potential state changes
    // 3. Token transfers
    // Conservative estimate: ~10,000 stroops
    return stroopsToXLM(SOROBAN_CONTRACT_FEE_STROOPS);
}

/**
 * Format fee for display
 */
export function formatFeeDisplay(feeInXLM: number): string {
    return `${feeInXLM.toFixed(7)} XLM`;
}

/**
 * Calculate total cost (stake + fees)
 * Note: Fees are always in XLM, but stake can be in USDC or XLM
 */
export function calculateTotalCost(
    stakeAmount: number,
    stakeCurrency: Currency,
    feeInXLM: number
): { amount: number; currency: Currency; feeInXLM: number } {
    if (stakeCurrency === "XLM") {
        return {
            amount: stakeAmount + feeInXLM,
            currency: "XLM",
            feeInXLM,
        };
    }

    // For USDC, we return stake separately and fee separately
    // since they're in different currencies
    return {
        amount: stakeAmount,
        currency: "USDC",
        feeInXLM,
    };
}

/**
 * Format total cost for display
 */
export function formatTotalCostDisplay(
    stakeAmount: number,
    stakeCurrency: Currency,
    feeInXLM: number
): string {
    const total = calculateTotalCost(stakeAmount, stakeCurrency, feeInXLM);

    if (stakeCurrency === "XLM") {
        return `${total.amount.toFixed(7)} XLM (includes ${formatFeeDisplay(feeInXLM)} fee)`;
    }

    return `${stakeAmount.toFixed(2)} USDC + ${formatFeeDisplay(feeInXLM)} fee`;
}
