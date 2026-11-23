// #1832: Maintain incremental heads/tails tallies at reveal time
export interface TallyState {
  heads: number
  tails: number
  lastUpdated: number
}

export class TallyManager {
  private tallies = new Map<string, TallyState>()

  revealAndTally(roundId: string, outcome: 'heads' | 'tails') {
    const current = this.tallies.get(roundId) || { heads: 0, tails: 0, lastUpdated: 0 }
    if (outcome === 'heads') current.heads++
    else current.tails++
    current.lastUpdated = Date.now()
    this.tallies.set(roundId, current)
    return current
  }

  getTally(roundId: string): TallyState | undefined {
    return this.tallies.get(roundId)
  }

  getRoundStats(roundId: string) {
    const tally = this.getTally(roundId)
    if (!tally) return null
    const total = tally.heads + tally.tails
    return {
      heads: tally.heads,
      tails: tally.tails,
      headsPercent: total > 0 ? (tally.heads / total * 100).toFixed(2) : 0,
      tailsPercent: total > 0 ? (tally.tails / total * 100).toFixed(2) : 0
    }
  }

  clear() { this.tallies.clear() }
}
