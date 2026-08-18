import pino from 'pino';
import { env } from './config';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'brandlens-worker' },
  redact: {
    paths: ['secret', '*.secret', 'apiKey', 'password', 'engineSecret'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
