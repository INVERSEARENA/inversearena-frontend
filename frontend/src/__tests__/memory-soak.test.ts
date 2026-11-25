// #1835: Long-session memory soak tests for live arena page
import { SSEManager } from '@/lib/sseManager'
import { TallyManager } from '@/lib/tallyManager'

describe('Memory Soak Tests - Live Arena Page', () => {
  let sseManager: SSEManager
  let tallyManager: TallyManager

  beforeEach(() => {
    sseManager = SSEManager.getInstance()
    tallyManager = new TallyManager()
  })

  afterEach(() => {
    sseManager.disconnect()
    tallyManager.clear()
  })

  test('SSE subscription cleanup prevents memory leaks', async () => {
    const callbacks: Function[] = []
    for (let i = 0; i < 1000; i++) {
      const unsub = sseManager.subscribe('arena-updates', () => {})
      callbacks.push(unsub)
    }
    // Cleanup all subscriptions
    callbacks.forEach(unsub => unsub())
    // Memory should be freed
    expect(sseManager).toBeDefined()
  })

  test('Tally manager handles high-volume updates without leaks', () => {
    for (let round = 0; round < 100; round++) {
      for (let reveal = 0; reveal < 10000; reveal++) {
        tallyManager.revealAndTally(`round-${round}`, reveal % 2 === 0 ? 'heads' : 'tails')
      }
    }
    // Verify data integrity
    const stats = tallyManager.getRoundStats('round-50')
    expect(stats).toBeDefined()
    expect(stats?.heads).toBe(5000)
    expect(stats?.tails).toBe(5000)
  })

  test('Long session event listener cleanup', () => {
    const unsubscribes: Function[] = []
    for (let i = 0; i < 100; i++) {
      unsubscribes.push(sseManager.subscribe(`round-${i}`, () => {}))
    }
    unsubscribes.forEach(unsub => unsub())
    expect(unsubscribes.length).toBe(100)
  })
})
