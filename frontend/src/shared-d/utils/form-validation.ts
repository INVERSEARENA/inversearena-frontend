/**
 * Form validation utilities for PoolCreationModal
 */

export type Currency = "USDC" | "XLM";

export interface ValidationResult {
    isValid: boolean;
    error?: string;
}

export interface StakeValidationParams {
    amount: string;
    currency: Currency;
    minStake: number;
    maxStake: number;
}

/**
 * Get decimal precision for a given currency
 */
export function getDecimalPrecision(currency: Currency): number {
    return currency === "USDC" ? 2 : 7;
}

/**
 * Check if a number has valid decimal precision for the currency
 */
export function isValidDecimalPrecision(value: string, currency: Currency): boolean {
    const precision = getDecimalPrecision(currency);
    const parts = value.split(".");

    if (parts.length === 1) {
        return true; // No decimal point
    }

    if (parts.length === 2) {
        return parts[1].length <= precision;
    }

    return false; // Multiple decimal points
}

/**
 * Sanitize numeric input to allow only valid characters
 * Allows: digits, one decimal point, and leading minus (for detection/rejection)
 */
export function sanitizeNumericInput(input: string): string {
    // Remove all characters except digits, decimal point, and minus
    let sanitized = input.replace(/[^\d.-]/g, "");

    // Remove minus signs (we don't allow negative numbers)
    sanitized = sanitized.replace(/-/g, "");

    // Ensure only one decimal point
    const parts = sanitized.split(".");
    if (parts.length > 2) {
        sanitized = parts[0] + "." + parts.slice(1).join("");
    }

    return sanitized;
}

/**
 * Format currency input based on currency type
 */
export function formatCurrencyInput(value: string, currency: Currency): string {
    if (!value) return "";

    const sanitized = sanitizeNumericInput(value);
    const precision = getDecimalPrecision(currency);

    // If there's a decimal point, limit the decimal places
    const parts = sanitized.split(".");
    if (parts.length === 2) {
        return parts[0] + "." + parts[1].slice(0, precision);
    }

    return sanitized;
}

/**
 * Validate stake amount
 */
export function validateStakeAmount(params: StakeValidationParams): ValidationResult {
    const { amount, currency, minStake, maxStake } = params;

    // Empty check
    if (!amount || amount.trim() === "") {
        return {
            isValid: false,
            error: "Stake amount is required",
        };
    }

    // Check for invalid format
    if (amount === "." || amount.endsWith(".") && amount.split(".")[1] === "") {
        return {
            isValid: false,
            error: "Please enter a valid amount",
        };
    }

    const numericValue = parseFloat(amount);

    // Check if it's a valid number
    if (isNaN(numericValue)) {
        return {
            isValid: false,
            error: "Please enter a valid number",
        };
    }

    // Check for negative numbers
    if (numericValue < 0) {
        return {
            isValid: false,
            error: "Stake amount cannot be negative",
        };
    }

    // Check for zero
    if (numericValue === 0) {
        return {
            isValid: false,
            error: "Stake amount must be greater than zero",
        };
    }

    // Check minimum stake
    if (numericValue < minStake) {
        return {
            isValid: false,
            error: `Minimum stake is ${minStake} ${currency}`,
        };
    }

    // Check maximum stake (balance)
    if (numericValue > maxStake) {
        return {
            isValid: false,
            error: `Insufficient balance. Maximum: ${maxStake.toFixed(getDecimalPrecision(currency))} ${currency}`,
        };
    }

    // Check decimal precision
    if (!isValidDecimalPrecision(amount, currency)) {
        const precision = getDecimalPrecision(currency);
        return {
            isValid: false,
            error: `${currency} allows up to ${precision} decimal place${precision > 1 ? "s" : ""}`,
        };
    }

    return { isValid: true };
}

/**
 * Validate arena capacity
 */
export function validateArenaCapacity(capacity: number, min: number, max: number): ValidationResult {
    if (capacity < min) {
        return {
            isValid: false,
            error: `Minimum capacity is ${min}`,
        };
    }

    if (capacity > max) {
        return {
            isValid: false,
            error: `Maximum capacity is ${max}`,
        };
    }

    return { isValid: true };
}

/**
 * Format number for display with proper decimal places
 */
export function formatNumberDisplay(value: number, currency: Currency): string {
    const precision = getDecimalPrecision(currency);
    return value.toFixed(precision);
}
