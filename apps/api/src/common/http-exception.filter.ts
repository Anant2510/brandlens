import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CORRELATION_ID_HEADER } from './correlation-id.middleware';

/** Mirrors `ApiError` from @brandlens/contracts. The web client parses this. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  correlationId?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = (req.headers[CORRELATION_ID_HEADER] as string | undefined) ?? undefined;

    const body = this.toBody(exception, correlationId);

    if (body.statusCode >= 500) {
      this.logger.error(
        { correlationId, path: req.url, err: exception instanceof Error ? exception.stack : exception },
        'unhandled error',
      );
    }

    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, correlationId?: string): ApiErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { statusCode: status, error: exception.name, message: payload, correlationId };
      }

      const obj = payload as Record<string, unknown>;
      return {
        statusCode: status,
        error: (obj.error as string) ?? exception.name,
        message: (obj.message as string | string[]) ?? exception.message,
        correlationId,
      };
    }

    // Postgres surfaces uniqueness violations as `23505`; that is a client
    // error (duplicate slug, duplicate job key), never a 500.
    const pgCode = (exception as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      return {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'A resource with that identity already exists',
        correlationId,
      };
    }
    if (pgCode === '23503') {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'BadRequest',
        message: 'Referenced resource does not exist',
        correlationId,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: exception instanceof Error ? exception.message : 'Unexpected error',
      correlationId,
    };
  }
}
