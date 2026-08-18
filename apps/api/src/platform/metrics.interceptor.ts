import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Records request counts and latency.
 *
 * The route TEMPLATE is used as the label, never the concrete path: labelling
 * with `/v1/checks/<uuid>` would give Prometheus one series per check run and
 * take the scrape down inside a day.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { route?: { path?: string } }>();
    const res = http.getResponse<Response>();
    const started = process.hrtime.bigint();
    const route = req.route?.path ?? normalise(req.path);

    return next.handle().pipe(
      tap({
        next: () => this.record(req.method, route, res.statusCode, started),
        error: (err: { status?: number }) => this.record(req.method, route, err?.status ?? 500, started),
      }),
    );
  }

  private record(method: string, route: string, status: number, started: bigint): void {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const labels = { method, route, status: String(status) };
    this.metrics.incr('brandlens_http_requests_total', labels);
    this.metrics.observe('brandlens_http_request_duration_seconds', seconds, { method, route });
  }
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function normalise(path: string): string {
  return path.replace(UUID, ':id');
}
