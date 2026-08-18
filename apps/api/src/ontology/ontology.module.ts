import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { OntologyController } from './ontology.controller';
import { OntologyService } from './ontology.service';

@Module({
  imports: [BrandsModule],
  controllers: [OntologyController],
  providers: [OntologyService],
  exports: [OntologyService],
})
export class OntologyModule {}
