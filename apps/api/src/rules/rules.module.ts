import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({
  imports: [BrandsModule],
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
