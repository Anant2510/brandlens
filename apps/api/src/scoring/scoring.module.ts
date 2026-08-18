import { Global, Module } from '@nestjs/common';
import { ScoringService } from './scoring.service';

@Global()
@Module({
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
