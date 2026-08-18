import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { AssembleController } from './assemble.controller';
import { AssembleService } from './assemble.service';

@Module({
  imports: [BrandsModule],
  controllers: [AssembleController],
  providers: [AssembleService],
  exports: [AssembleService],
})
export class AssembleModule {}
