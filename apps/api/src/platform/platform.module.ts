import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { ChannelSpecsController } from './channel-specs.controller';
import { HealthController } from './health.controller';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';

@Module({
  controllers: [ApiKeysController, WebhooksController, ChannelSpecsController, HealthController],
  providers: [WebhooksService, MetricsService, MetricsInterceptor],
  exports: [WebhooksService, MetricsService, MetricsInterceptor],
})
export class PlatformModule {}
