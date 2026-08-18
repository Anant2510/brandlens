import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * A single id follows a request from the HTTP edge, through the queue, into
 * the Python engine and back out on the webhook. Without it, debugging an
 * asynchronous check that touched four processes is guesswork.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    req.headers[CORRELATION_ID_HEADER] = id;
    res.setHeader(CORRELATION_ID_HEADER, id);
    next();
  }
}

export function correlationIdOf(req: { headers: Record<string, unknown> }): string {
  const v = req.headers[CORRELATION_ID_HEADER];
  return (Array.isArray(v) ? v[0] : v) as string;
}
