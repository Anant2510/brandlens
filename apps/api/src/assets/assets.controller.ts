import {
  BadRequestException,
  NotFoundException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RegisterAssetInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Scopes } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { PageQuery, type PageResult } from '../common/pagination';
import { AssetsService, type AssetDto } from './assets.service';
import type { TenantContext } from '../database/tenant-context.service';
import type { UploadedFileLike } from '../ontology/ontology.controller';

const ListQuery = PageQuery.extend({
  brandId: z.string().uuid().optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
  variantFamilyId: z.string().uuid().optional(),
  isApprovedExemplar: z.coerce.boolean().optional(),
});

const RegisterByUrlInput = RegisterAssetInput.extend({ url: z.string().url() });

@ApiTags('assets')
@ApiBearerAuth()
@Controller('v1/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @Scopes('assets:read')
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'kind', required: false })
  @ApiOperation({ summary: 'List assets' })
  list(@OrgId() orgId: string, @Query() query: Record<string, string>): Promise<PageResult<AssetDto>> {
    return this.assets.list(orgId, ListQuery.parse(query));
  }

  /**
   * Accepts either `multipart/form-data` with a `file` part, or JSON with a
   * `url` (register-by-reference), or a `copy`-kind asset with no bytes at all.
   */
  @Post()
  @Scopes('assets:write')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({ summary: 'Upload an asset, or register one by URL' })
  async create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFile() file?: UploadedFileLike,
  ) {
    const body = coerce(rawBody);

    if (file) {
      const parsed = RegisterAssetInput.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return this.assets.upload(orgId, user.userId, parsed.data, file);
    }

    if (typeof body.url === 'string') {
      const parsed = RegisterByUrlInput.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return this.assets.registerByUrl(orgId, user.userId, parsed.data);
    }

    const parsed = RegisterAssetInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    if (parsed.data.kind !== 'copy') {
      throw new BadRequestException('Provide a multipart `file`, a `url`, or set kind="copy" with copyFields');
    }
    return { asset: await this.assets.registerCopy(orgId, user.userId, parsed.data), deduped: false, jobId: null };
  }

  @Get(':assetId')
  @Scopes('assets:read')
  @ApiOperation({ summary: 'Fetch one asset with a signed preview URL' })
  get(@OrgId() orgId: string, @Param('assetId') assetId: string): Promise<AssetDto> {
    return this.assets.get(orgId, assetId);
  }

  @Delete(':assetId')
  @Scopes('assets:write')
  @ApiOperation({ summary: 'Soft-delete an asset (check history is retained)' })
  remove(@OrgId() orgId: string, @Param('assetId') assetId: string) {
    return this.assets.remove(orgId, assetId);
  }

  /**
   * Redirects to a signed, expiring URL rather than proxying the bytes: the
   * API process should not be a file server, and on the cloud drivers the
   * browser can talk to object storage directly.
   */
  @Get(':assetId/preview')
  @Scopes('assets:read')
  @Redirect()
  @ApiQuery({ name: 'download', required: false, type: Boolean })
  @ApiOperation({ summary: 'Redirect to a signed preview/download URL' })
  async preview(
    @OrgId() orgId: string,
    @Param('assetId') assetId: string,
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const row = await this.assets.findRow(orgId, assetId);
    const url = await this.assets.previewUrl(orgId, row, download === 'true' ? 'attachment' : 'inline');
    if (!url) throw new NotFoundException('This asset has no renderable bytes (copy-only submission)');
    return { url, statusCode: 302 };
  }

  @Get(':assetId/derivatives')
  @Scopes('assets:read')
  @ApiOperation({ summary: 'List generated derivatives (thumbnails, crops, page rasters)' })
  derivatives(@OrgId() orgId: string, @Param('assetId') assetId: string) {
    return this.assets.derivatives(orgId, assetId);
  }
}

/** multipart fields arrive as strings; parse the JSON-shaped ones. */
function coerce(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        out[k] = JSON.parse(t);
        continue;
      } catch {
        /* keep the raw string */
      }
    }
    if (v === 'true') out[k] = true;
    else if (v === 'false') out[k] = false;
    else out[k] = v;
  }
  return out;
}
