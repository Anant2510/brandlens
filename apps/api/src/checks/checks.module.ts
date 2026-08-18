import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { BrandsModule } from '../brands/brands.module';
import { RulesetsModule } from '../rulesets/rulesets.module';
import { ChecksController } from './checks.controller';
import { ChecksService } from './checks.service';
import { FindingsController } from './findings.controller';
import { FindingsService } from './findings.service';

@Module({
  imports: [AssetsModule, BrandsModule, RulesetsModule],
  controllers: [ChecksController, FindingsController],
  providers: [ChecksService, FindingsService],
  exports: [ChecksService, FindingsService],
})
export class ChecksModule {}
