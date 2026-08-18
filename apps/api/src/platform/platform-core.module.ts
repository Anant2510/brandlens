import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * The outbox is needed by nearly every domain module (a state change that
 * nobody can subscribe to is not much of a state change), so it lives in its
 * own global module rather than in the feature module that owns webhooks.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class PlatformCoreModule {}
