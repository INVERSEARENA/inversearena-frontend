export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly maxTokens: number;
  private readonly refillInterval: number; // in milliseconds

  constructor(maxTokens: number, refillInterval: number) {
    this.maxTokens = maxTokens;
    this.refillInterval = refillInterval;
    this.tokens = maxTokens;
    this.lastRefillTime = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const tokensToAdd = (timePassed / this.refillInterval) * this.maxTokens;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  tryConsume(count: number = 1): boolean {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }
}
