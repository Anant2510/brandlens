import { Global, Module } from '@nestjs/common';
import { EngineClient } from './engine.client';
import { BrandContextBuilder } from './brand-context.builder';

@Global()
@Module({
  providers: [EngineClient, BrandContextBuilder],
  exports: [EngineClient, BrandContextBuilder],
})
export class EngineModule {}
