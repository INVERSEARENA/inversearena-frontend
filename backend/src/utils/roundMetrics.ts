export class RoundMetrics {
  private resolutionCount = 0;
  private resolutionErrors = 0;
  private totalResolutionTime = 0;
  private eliminationCounts: Record<string, number> = {};

  recordResolution(durationMs: number, success: boolean, eliminatedCount: number): void {
    this.resolutionCount++;
    this.totalResolutionTime += durationMs;
    
    if (!success) {
      this.resolutionErrors++;
    }

    const bucket = this.getBucket(eliminatedCount);
    this.eliminationCounts[bucket] = (this.eliminationCounts[bucket] || 0) + 1;
  }

  private getBucket(count: number): string {
    if (count === 0) return '0';
    if (count <= 2) return '1-2';
    if (count <= 5) return '3-5';
    if (count <= 10) return '6-10';
    return '10+';
  }

  getMetrics() {
    return {
      round_resolutions_total: this.resolutionCount,
      round_resolution_errors_total: this.resolutionErrors,
      round_resolution_duration_avg_ms: 
        this.resolutionCount > 0 ? this.totalResolutionTime / this.resolutionCount : 0,
      round_eliminations_distribution: this.eliminationCounts,
      round_success_rate: 
        this.resolutionCount > 0 
          ? ((this.resolutionCount - this.resolutionErrors) / this.resolutionCount) * 100 
          : 100,
    };
  }

  toPrometheusFormat(): string {
    const metrics = this.getMetrics();
    return `
# HELP round_resolutions_total Total number of round resolutions
# TYPE round_resolutions_total counter
round_resolutions_total ${metrics.round_resolutions_total}

# HELP round_resolution_errors_total Total number of failed resolutions
# TYPE round_resolution_errors_total counter
round_resolution_errors_total ${metrics.round_resolution_errors_total}

# HELP round_resolution_duration_avg_ms Average resolution duration in milliseconds
# TYPE round_resolution_duration_avg_ms gauge
round_resolution_duration_avg_ms ${metrics.round_resolution_duration_avg_ms}

# HELP round_success_rate Percentage of successful resolutions
# TYPE round_success_rate gauge
round_success_rate ${metrics.round_success_rate}
`.trim();
  }
}

export const roundMetrics = new RoundMetrics();
