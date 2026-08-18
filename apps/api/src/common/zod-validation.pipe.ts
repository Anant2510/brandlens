import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodTypeAny, z } from 'zod';

/**
 * Validation is done with the zod schemas from `@brandlens/contracts` rather
 * than a second set of class-validator DTOs. One schema serves the API, the
 * worker and the web client, so a contract change cannot drift between them.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    try {
      return this.schema.parse(value) as z.infer<T>;
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          error: 'ValidationError',
          message: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        });
      }
      throw err;
    }
  }
}

/** Terser call-site: `@Body(zodBody(CreateCheckInput)) body: CreateCheckInput`. */
export function zodBody<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * Global pipe. Only touches payloads that a controller explicitly opted into
 * via `@ZodSchema()`; everything else passes through untouched so route params
 * and file uploads are not mangled.
 */
@Injectable()
export class GlobalZodValidationPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as unknown as { zodSchema?: ZodTypeAny })?.zodSchema;
    if (!schema) return value;
    return new ZodValidationPipe(schema).transform(value, metadata);
  }
}
