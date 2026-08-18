import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { ApiKeyService } from './api-key.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { CombinedAuthGuard } from './guards/combined-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantBindingInterceptor } from './tenant-binding.interceptor';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    ApiKeyService,
    JwtAuthGuard,
    ApiKeyGuard,
    CombinedAuthGuard,
    RolesGuard,
    TenantBindingInterceptor,
  ],
  exports: [AuthService, TokenService, ApiKeyService, CombinedAuthGuard, RolesGuard, TenantBindingInterceptor],
})
export class AuthModule {}
