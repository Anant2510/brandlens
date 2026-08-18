import { Injectable, LoggerService, Scope } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';

/**
 * Structured JSON logs by default. On a single Windows VM the operator reads
 * these with `pm2 logs`, so we keep them one-line-per-event and never
 * interleave stack traces with message text.
 */
function createRootLogger(): PinoLogger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'brandlens-api' },
    redact: {
      // Never let a bearer token or an API key reach disk.
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'passwordHash',
        'plaintext',
        'secret',
        '*.secret',
        'apiKey',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const rootLogger: PinoLogger = createRootLogger();

@Injectable({ scope: Scope.TRANSIENT })
export class AppLogger implements LoggerService {
  private logger: PinoLogger = rootLogger;

  setContext(context: string): void {
    this.logger = rootLogger.child({ context });
  }

  child(bindings: Record<string, unknown>): PinoLogger {
    return this.logger.child(bindings);
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(this.merge(message, optional));
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.logger.error(this.merge(message, optional));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(this.merge(message, optional));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(this.merge(message, optional));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace(this.merge(message, optional));
  }

  private merge(message: unknown, optional: unknown[]): Record<string, unknown> {
    const base: Record<string, unknown> =
      typeof message === 'object' && message !== null
        ? ({ ...message } as Record<string, unknown>)
        : { msg: String(message) };
    if (optional.length > 0) base.detail = optional.length === 1 ? optional[0] : optional;
    return base;
  }
}
