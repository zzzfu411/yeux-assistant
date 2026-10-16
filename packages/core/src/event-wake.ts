import pg from 'pg';

export const EVENT_CHANNEL = 'app_events';
/**
 * Wakes live connections when an event commits. event() sends NOTIFY inside its transaction, so the
 * signal arrives only after commit; the publication order still comes from app.events. While the
 * listening connection is down, `healthy` is false and readers fall back to polling.
 */
export class EventWake {
  healthy = false;
  private client: pg.Client | undefined;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(readonly url: string) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async start() {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.url, connectionTimeoutMillis: 5000 });
    const lost = () => {
      if (this.client !== client) return;
      this.healthy = false;
      this.client = undefined;
      void client.end().catch(() => {});
      if (!this.closed) this.retry = setTimeout(() => void this.start(), 2000);
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', () => {
      for (const listener of this.listeners) listener();
    });
    this.client = client;
    try {
      await client.connect();
      await client.query('LISTEN ' + EVENT_CHANNEL);
      if (this.client === client) {
        this.healthy = true;
        // Anything committed while no one was listening is picked up by one immediate read.
        for (const listener of this.listeners) listener();
      }
    } catch {
      lost();
    }
  }
  async close() {
    this.closed = true;
    this.healthy = false;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }
}
