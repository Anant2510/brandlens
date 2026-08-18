import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { AppConfigService } from '../config/config.service';
import type { MemberRole } from '../database/tenant-context.service';

export interface AccessTokenClaims {
  sub: string;
  orgId: string;
  role: MemberRole;
  email: string;
  typ: 'access';
}

export interface RefreshTokenClaims {
  sub: string;
  orgId: string;
  jti: string;
  typ: 'refresh';
}

@Injectable()
export class TokenService {
  constructor(private readonly config: AppConfigService) {}

  signAccess(claims: Omit<AccessTokenClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'access' }, this.config.env.JWT_ACCESS_SECRET, {
      expiresIn: this.config.env.JWT_ACCESS_TTL,
      issuer: 'brandlens',
    } as SignOptions);
  }

  signRefresh(claims: Omit<RefreshTokenClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'refresh' }, this.config.env.JWT_REFRESH_SECRET, {
      expiresIn: this.config.env.JWT_REFRESH_TTL,
      issuer: 'brandlens',
    } as SignOptions);
  }

  verifyAccess(token: string): AccessTokenClaims {
    try {
      const decoded = jwt.verify(token, this.config.env.JWT_ACCESS_SECRET, { issuer: 'brandlens' });
      const claims = decoded as unknown as AccessTokenClaims;
      // Separate secrets already prevent it, but rejecting the wrong `typ`
      // makes refresh-token-as-access-token impossible even if they are ever
      // misconfigured to the same value.
      if (claims.typ !== 'access') throw new Error('wrong token type');
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  verifyRefresh(token: string): RefreshTokenClaims {
    try {
      const decoded = jwt.verify(token, this.config.env.JWT_REFRESH_SECRET, { issuer: 'brandlens' });
      const claims = decoded as unknown as RefreshTokenClaims;
      if (claims.typ !== 'refresh') throw new Error('wrong token type');
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /** Access-token lifetime in seconds, for the `expiresIn` field of the DTO. */
  get accessTtlSeconds(): number {
    return parseDuration(this.config.env.JWT_ACCESS_TTL);
  }

  get refreshTtlSeconds(): number {
    return parseDuration(this.config.env.JWT_REFRESH_TTL);
  }
}

export function parseDuration(value: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!m) return 900;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 86_400;
    case 'h':
      return n * 3_600;
    case 'm':
      return n * 60;
    default:
      return n;
  }
}
