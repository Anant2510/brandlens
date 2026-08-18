import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Database, closeDb, getDb } from '@brandlens/db';
import { AppConfigService } from '../config/config.service';
import { DB } from './database.tokens';
import { TenantContextService } from './tenant-context.service';
import { TenantRepository } from './tenant.repository';

export { DB } from './database.tokens';

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Database =>
        getDb({
          connectionString: config.env.DATABASE_URL,
          max: config.env.DATABASE_POOL_MAX,
          ssl: config.env.DATABASE_SSL,
        }),
    },
    TenantContextService,
    TenantRepository,
  ],
  exports: [DB, TenantContextService, TenantRepository],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // Drain the pool on SIGTERM so in-flight transactions finish rather than
    // being severed mid-write.
    await closeDb();
  }
}
