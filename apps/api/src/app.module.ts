import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { LoggerModule } from './common/logger.module';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { EngineModule } from './engine/engine.module';
import { ScoringModule } from './scoring/scoring.module';
import { LearningModule } from './learning/learning.module';
import { PlatformCoreModule } from './platform/platform-core.module';

import { BrandsModule } from './brands/brands.module';
import { OntologyModule } from './ontology/ontology.module';
import { RulesModule } from './rules/rules.module';
import { RulesetsModule } from './rulesets/rulesets.module';
import { AssetsModule } from './assets/assets.module';
import { ChecksModule } from './checks/checks.module';
import { ReviewModule } from './review/review.module';
import { AssembleModule } from './assemble/assemble.module';
import { PredictModule } from './predict/predict.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PlatformModule } from './platform/platform.module';
import { McpModule } from './mcp/mcp.module';

import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { TenantBindingInterceptor } from './auth/tenant-binding.interceptor';
import { MetricsInterceptor } from './platform/metrics.interceptor';

@Module({
  imports: [
    /* infrastructure (all @Global) */
    AppConfigModule,
    LoggerModule,
    DatabaseModule,
    StorageModule,
    QueueModule,
    AuditModule,
    AuthModule,
    EngineModule,
    ScoringModule,
    LearningModule,
    PlatformCoreModule,

    /* domain */
    BrandsModule,
    OntologyModule,
    RulesModule,
    RulesetsModule,
    AssetsModule,
    ChecksModule,
    ReviewModule,
    AssembleModule,
    PredictModule,
    DiscoveryModule,
    AnalyticsModule,
    OrganizationsModule,
    PlatformModule,
    McpModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    /* Authentication is on by default; a route opts out with @Public(). The
     * failure mode of the opposite arrangement is an unauthenticated endpoint
     * that nobody notices until it is in a pen-test report. */
    { provide: APP_GUARD, useClass: CombinedAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    /* Order matters: the tenant must be bound into AsyncLocalStorage before
     * any handler runs, and metrics should wrap the whole thing. */
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantBindingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
