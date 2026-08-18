import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { BrandsModule } from '../brands/brands.module';
import { PredictController } from './predict.controller';
import { PredictService } from './predict.service';

@Module({
  imports: [AssetsModule, BrandsModule],
  controllers: [PredictController],
  providers: [PredictService],
  exports: [PredictService],
})
export class PredictModule {}
