import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { RulePacksController } from './rule-packs.controller';
import { RulePacksService } from './rule-packs.service';

@Module({
  imports: [BrandsModule],
  controllers: [RulePacksController],
  providers: [RulePacksService],
  exports: [RulePacksService],
})
export class RulePacksModule {}
