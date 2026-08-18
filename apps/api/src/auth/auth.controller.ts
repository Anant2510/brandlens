import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { LoginInput, RegisterInput } from '@brandlens/contracts';
import type { Request } from 'express';
import { AuthService, type AuthResult, type SessionUserDto } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import type { TenantContext } from '../database/tenant-context.service';

const RefreshInput = z.object({ refreshToken: z.string().min(10) });
const LogoutInput = z.object({ refreshToken: z.string().optional() });

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an organization and its owner account' })
  @ApiBody({ schema: { type: 'object', example: { email: 'you@acme.com', password: 'correct-horse-battery', organizationName: 'Acme' } } })
  @ApiOkResponse({ description: 'Access + refresh tokens and the session user' })
  async register(
    @Body(zodBody(RegisterInput)) body: z.infer<typeof RegisterInput>,
    @Req() req: Request,
  ): Promise<AuthResult> {
    return this.auth.register(body, meta(req));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for tokens' })
  @ApiBody({ schema: { type: 'object', example: { email: 'you@acme.com', password: 'correct-horse-battery' } } })
  async login(@Body(zodBody(LoginInput)) body: z.infer<typeof LoginInput>, @Req() req: Request): Promise<AuthResult> {
    return this.auth.login(body, meta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token for a new token pair' })
  async refresh(
    @Body(zodBody(RefreshInput)) body: z.infer<typeof RefreshInput>,
    @Req() req: Request,
  ): Promise<AuthResult> {
    return this.auth.refresh(body.refreshToken, meta(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body(zodBody(LogoutInput)) body: z.infer<typeof LogoutInput>): Promise<{ revoked: number }> {
    return this.auth.logout(body.refreshToken, undefined);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated session user' })
  async me(@CurrentUser() user: TenantContext): Promise<SessionUserDto> {
    if (!user.userId) {
      // API keys are machine identities: they have an org but no person.
      return {
        id: user.apiKeyId ?? 'api-key',
        email: 'service@brandlens',
        name: 'API key',
        orgId: user.orgId,
        orgName: '',
        orgSlug: '',
        role: 'service',
      };
    }
    return this.auth.me(user.userId, user.orgId);
  }
}

function meta(req: Request): { ip?: string; userAgent?: string } {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
