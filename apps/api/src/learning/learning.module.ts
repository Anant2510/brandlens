import { Global, Module } from '@nestjs/common';
import { VectorSearchService } from './vector-search.service';
import { PrecedentService } from './precedent.service';
import { CalibrationService } from './calibration.service';

@Global()
@Module({
  providers: [VectorSearchService, PrecedentService, CalibrationService],
  exports: [VectorSearchService, PrecedentService, CalibrationService],
})
export class LearningModule {}
