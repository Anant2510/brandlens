import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { PlatformCoreModule } from '../platform/platform-core.module';
import { RulesetsController } from './rulesets.controller';
import { RulesetCompilerService } from './ruleset-compiler.service';

@Module({
  imports: [BrandsModule, PlatformCoreModule],
  controllers: [RulesetsController],
  providers: [RulesetCompilerService],
  exports: [RulesetCompilerService],
})
export class RulesetsModule {}
