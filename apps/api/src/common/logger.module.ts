import { Global, Module } from '@nestjs/common';
import { AppLogger } from './logger.service';

/**
 * `AppLogger` is transient-scoped so each consumer can bind its own context
 * label, which means it has to be a registered provider rather than a value
 * Nest can construct on demand.
 */
@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class LoggerModule {}
