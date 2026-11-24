// #1831: Multiplex all arena subscriptions over one SSE connection per client
export class SSEManager {
  private static instance: SSEManager | null = null
  private connection: EventSource | null = null
  private subscriptions = new Map<string, Function[]>()

  static getInstance() {
    if (!SSEManager.instance) {
      SSEManager.instance = new SSEManager()
    }
    return SSEManager.instance
  }

  subscribe(channel: string, callback: (data: any) => void) {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, [])
    }
    this.subscriptions.get(channel)!.push(callback)
    if (!this.connection) this.connect()
    return () => this.unsubscribe(channel, callback)
  }

  private connect() {
    this.connection = new EventSource('/api/arenas/stream')
    this.connection.addEventListener('message', (e) => {
      const { channel, data } = JSON.parse(e.data)
      this.subscriptions.get(channel)?.forEach(cb => cb(data))
    })
    this.connection.onerror = () => {
      setTimeout(() => { this.connection = null; this.connect() }, 1000)
    }
  }

  private unsubscribe(channel: string, callback: Function) {
    const cbs = this.subscriptions.get(channel)
    if (cbs) cbs.splice(cbs.indexOf(callback), 1)
  }

  disconnect() { this.connection?.close() }
}
