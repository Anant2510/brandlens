import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { ChecksModule } from '../checks/checks.module';
import { RulesetsModule } from '../rulesets/rulesets.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [ChecksModule, RulesetsModule, BrandsModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
