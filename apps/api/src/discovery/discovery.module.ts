import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { BrandsModule } from '../brands/brands.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [AssetsModule, BrandsModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
