import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantRepository } from '../database/tenant.repository';

interface HistogramState {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180];

/**
 * Prometheus exposition, hand-rolled.
 *
 * `prom-client` is a fine library, but the metric set here is a dozen series
 * and the exposition format is a hundred lines of string building. Avoiding
 * the dependency keeps the Windows install path to "pnpm install and go".
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();
  private healthy = true;

  constructor(private readonly repo: TenantRepository) {}

  incr(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    const key = seriesKey(name, labels);
    const state = this.histograms.get(key) ?? { buckets: new Map(), sum: 0, count: 0 };
    for (const bucket of LATENCY_BUCKETS) {
      if (seconds <= bucket) state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
    }
    state.sum += seconds;
    state.count += 1;
    this.histograms.set(key, state);
  }

  setHealth(ok: boolean): void {
    this.healthy = ok;
  }

  /** Renders the in-process counters plus a few queries against the database. */
  async render(): Promise<string> {
    const lines: string[] = [];

    lines.push('# HELP brandlens_up 1 when the last deep health check passed');
    lines.push('# TYPE brandlens_up gauge');
    lines.push(`brandlens_up ${this.healthy ? 1 : 0}`);

    lines.push('# HELP brandlens_process_uptime_seconds Process uptime');
    lines.push('# TYPE brandlens_process_uptime_seconds gauge');
    lines.push(`brandlens_process_uptime_seconds ${Math.round(process.uptime())}`);

    const mem = process.memoryUsage();
    lines.push('# HELP brandlens_process_resident_memory_bytes Resident set size');
    lines.push('# TYPE brandlens_process_resident_memory_bytes gauge');
    lines.push(`brandlens_process_resident_memory_bytes ${mem.rss}`);

    if (this.counters.size) {
      lines.push('# TYPE brandlens_http_requests_total counter');
      for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    }

    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);

    for (const [key, state] of this.histograms) {
      const { name, labelPart } = splitSeries(key);
      lines.push(`# TYPE ${name} histogram`);
      let cumulative = 0;
      for (const bucket of LATENCY_BUCKETS) {
        cumulative = state.buckets.get(bucket) ?? cumulative;
        lines.push(`${name}_bucket{${joinLabels(labelPart, `le="${bucket}"`)}} ${cumulative}`);
      }
      lines.push(`${name}_bucket{${joinLabels(labelPart, 'le="+Inf"')}} ${state.count}`);
      lines.push(`${name}_sum${labelPart ? `{${labelPart}}` : ''} ${state.sum}`);
      lines.push(`${name}_count${labelPart ? `{${labelPart}}` : ''} ${state.count}`);
    }

    // Business metrics come from the database rather than process memory so
    // they survive a restart and are correct across multiple API processes.
    try {
      const stats = await this.repo.platform(async (tx) => {
        const res = await tx.execute(sql`
          SELECT
            (SELECT count(*) FROM check_runs WHERE created_at > now() - interval '24 hours')::int AS checks_24h,
            (SELECT count(*) FROM check_runs WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed_24h,
            (SELECT count(*) FROM check_runs WHERE status IN ('queued','running'))::int AS in_flight,
            (SELECT count(*) FROM findings WHERE status = 'open')::int AS open_findings,
            (SELECT count(*) FROM outbox_events WHERE status = 'pending')::int AS outbox_pending,
            (SELECT count(*) FROM outbox_events WHERE status = 'dead')::int AS outbox_dead,
            (SELECT coalesce(sum(cost_usd), 0) FROM check_runs WHERE created_at > now() - interval '24 hours')::float AS cost_24h,
            (SELECT coalesce(sum(cache_hits), 0) FROM check_runs WHERE created_at > now() - interval '24 hours')::int AS cache_hits_24h,
            (SELECT coalesce(sum(cache_misses), 0) FROM check_runs WHERE created_at > now() - interval '24 hours')::int AS cache_misses_24h
        `);
        return ((res as unknown as { rows: Array<Record<string, number>> }).rows ?? [])[0] ?? {};
      });

      const emit = (name: string, help: string, type: string, value: unknown) => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
        lines.push(`${name} ${Number(value ?? 0)}`);
      };

      emit('brandlens_checks_24h', 'Check runs started in the last 24h', 'gauge', stats.checks_24h);
      emit('brandlens_checks_failed_24h', 'Check runs that failed in the last 24h', 'gauge', stats.failed_24h);
      emit('brandlens_checks_in_flight', 'Check runs queued or running', 'gauge', stats.in_flight);
      emit('brandlens_findings_open', 'Findings awaiting a human decision', 'gauge', stats.open_findings);
      emit('brandlens_outbox_pending', 'Outbox events awaiting dispatch', 'gauge', stats.outbox_pending);
      emit('brandlens_outbox_dead', 'Outbox events in the dead-letter state', 'gauge', stats.outbox_dead);
      emit('brandlens_cost_usd_24h', 'Model spend in the last 24h', 'gauge', stats.cost_24h);

      const hits = Number(stats.cache_hits_24h ?? 0);
      const misses = Number(stats.cache_misses_24h ?? 0);
      emit(
        'brandlens_cache_hit_ratio_24h',
        'Share of criteria served from the trace cache',
        'gauge',
        hits + misses > 0 ? hits / (hits + misses) : 0,
      );
    } catch (err) {
      lines.push(`# database metrics unavailable: ${String(err).replace(/\n/g, ' ').slice(0, 200)}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function splitSeries(key: string): { name: string; labelPart: string } {
  const idx = key.indexOf('{');
  if (idx === -1) return { name: key, labelPart: '' };
  return { name: key.slice(0, idx), labelPart: key.slice(idx + 1, -1) };
}

function joinLabels(existing: string, extra: string): string {
  return existing ? `${existing},${extra}` : extra;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
