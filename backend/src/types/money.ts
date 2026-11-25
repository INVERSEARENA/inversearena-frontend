import { AssetMetadata, getAssetMetadata, formatAmount, parseAmount } from './asset';

/**
 * Represents a monetary amount with its associated asset (currency).
 * Uses BigInt for atomic amounts to prevent floating-point inaccuracies.
 */
export class Money {
  public readonly atomicAmount: bigint;
  public readonly asset: AssetMetadata;

  constructor(atomicAmount: bigint | string, assetCode: string, assetIssuer?: string) {
    this.atomicAmount = typeof atomicAmount === 'string' ? BigInt(atomicAmount) : atomicAmount;
    this.asset = getAssetMetadata(assetCode, assetIssuer);
  }

  /**
   * Creates a Money instance from a display amount (e.g., "1.23").
   */
  static fromDisplayAmount(displayAmount: string, assetCode: string, assetIssuer?: string): Money {
    const asset = getAssetMetadata(assetCode, assetIssuer);
    const atomicAmount = parseAmount(displayAmount, asset.decimals);
    return new Money(atomicAmount, assetCode, assetIssuer);
  }

  /**
   * Adds another Money amount to this one.
   * Throws an error if assets are not compatible.
   */
  add(other: Money): Money {
    if (this.asset.code !== other.asset.code || this.asset.issuer !== other.asset.issuer) {
      throw new Error('Cannot add Money amounts of different assets.');
    }
    return new Money(this.atomicAmount + other.atomicAmount, this.asset.code, this.asset.issuer);
  }

  /**
   * Subtracts another Money amount from this one.
   * Throws an error if assets are not compatible.
   */
  subtract(other: Money): Money {
    if (this.asset.code !== other.asset.code || this.asset.issuer !== other.asset.issuer) {
      throw new Error('Cannot subtract Money amounts of different assets.');
    }
    return new Money(this.atomicAmount - other.atomicAmount, this.asset.code, this.asset.issuer);
  }

  /**
   * Multiplies the Money amount by a number.
   */
  multiply(multiplier: number | bigint): Money {
    const newAtomicAmount = this.atomicAmount * BigInt(multiplier);
    return new Money(newAtomicAmount, this.asset.code, this.asset.issuer);
  }

  /**
   * Divides the Money amount by a number.
   */
  divide(divisor: number | bigint): Money {
    if (divisor === 0 || divisor === 0n) {
      throw new Error('Cannot divide Money by zero.');
    }
    const newAtomicAmount = this.atomicAmount / BigInt(divisor);
    return new Money(newAtomicAmount, this.asset.code, this.asset.issuer);
  }

  /**
   * Checks if this Money amount is equal to another.
   */
  equals(other: Money): boolean {
    return this.atomicAmount === other.atomicAmount &&
           this.asset.code === other.asset.code &&
           this.asset.issuer === other.asset.issuer;
  }

  /**
   * Checks if this Money amount is greater than another.
   */
  isGreaterThan(other: Money): boolean {
    if (this.asset.code !== other.asset.code || this.asset.issuer !== other.asset.issuer) {
      throw new Error('Cannot compare Money amounts of different assets.');
    }
    return this.atomicAmount > other.atomicAmount;
  }

  /**
   * Checks if this Money amount is less than another.
   */
  isLessThan(other: Money): boolean {
    if (this.asset.code !== other.asset.code || this.asset.issuer !== other.asset.issuer) {
      throw new Error('Cannot compare Money amounts of different assets.');
    }
    return this.atomicAmount < other.atomicAmount;
  }

  /**
   * Returns the amount formatted for display.
   */
  toDisplayString(): string {
    return formatAmount(this.atomicAmount, this.asset.decimals, this.asset.displayDecimals);
  }

  /**
   * Returns the USD equivalent value if available.
   */
  get usdValue(): number | undefined {
    // This would require an oracle or conversion service, which is beyond the scope of this refactor
    // For now, it remains undefined or can be calculated if a price is explicitly provided.
    return undefined;
  }
}
