/** Serialize capture work without blocking the public event stream. */
export class CaptureQueue {
  private readonly pending = new Map<string, () => Promise<void>>();
  private running: Promise<void> | undefined;

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(sessionID: string, task: () => Promise<void>): void {
    // Repeated notifications coalesce, but a notification during a running
    // capture gets a trailing pass: its message may not be in that snapshot.
    this.pending.set(sessionID, task);
    if (!this.running) {
      this.running = Promise.resolve().then(() => this.run());
    }
  }

  private async run(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const [sessionID, task] = this.pending.entries().next().value!;
        this.pending.delete(sessionID);
        try {
          await task();
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.running = undefined;
    }
  }

  async drain(): Promise<void> {
    while (this.running) await this.running;
  }
}
