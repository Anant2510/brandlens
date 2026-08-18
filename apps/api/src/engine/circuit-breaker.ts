export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold: number;
  /** How long to stay open before letting one probe through. */
  cooldownMs: number;
  /** Consecutive successes in half-open needed to close again. */
  successThreshold: number;
}

/**
 * Circuit breaker for the analysis engine.
 *
 * Without it, an engine that is down turns every queued analyze job into a
 * 180-second timeout, the llm_io pool fills with doomed work, and the whole
 * queue stalls behind a service that is not coming back this minute. Failing
 * fast lets the run degrade to deterministic-only results instead, which is a
 * partial answer — always better than an error.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  constructor(private readonly options: BreakerOptions) {}

  get current(): BreakerState {
    // Lazily transition out of `open` so we do not need a timer.
    if (this.state === 'open' && Date.now() - this.openedAt >= this.options.cooldownMs) {
      this.state = 'half_open';
      this.successes = 0;
    }
    return this.state;
  }

  canAttempt(): boolean {
    return this.current !== 'open';
  }

  recordSuccess(): void {
    if (this.current === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.options.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    if (this.current === 'half_open') {
      // The probe failed: go straight back to open, do not accumulate.
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.successes = 0;
  }

  snapshot(): { state: BreakerState; failures: number; openedAt: number | null } {
    return { state: this.current, failures: this.failures, openedAt: this.openedAt || null };
  }
}
