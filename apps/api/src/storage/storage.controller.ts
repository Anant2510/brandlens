import { Controller, ForbiddenException, Get, NotFoundException, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { StorageService } from './storage.service';

/**
 * Serves objects for the `local` driver against an HMAC signature.
 *
 * Public by design — the signature IS the authorisation, which is what lets an
 * <img src> in the web app render a preview without attaching a bearer token
 * to an image request.
 */
@ApiTags('storage')
@Controller('v1/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get('object')
  @ApiOperation({ summary: 'Fetch a signed storage object (local driver)' })
  @ApiOkResponse({ description: 'The object bytes' })
  @ApiExcludeEndpoint(false)
  async object(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('disposition') disposition: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!key || !sig) throw new ForbiddenException('Missing signature');
    const ok = this.storage.verifyLocalSignature(key, Number(expires), disposition || 'inline', sig);
    if (!ok) throw new ForbiddenException('Invalid or expired signature');

    const stat = await this.storage.stat(key);
    if (!stat) throw new NotFoundException('Object not found');

    const bytes = await this.storage.get(key);
    res.setHeader('content-type', stat.contentType ?? guessContentType(key));
    res.setHeader('content-length', String(bytes.byteLength));
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader(
      'content-disposition',
      `${disposition === 'attachment' ? 'attachment' : 'inline'}; filename="${key.split('/').pop() ?? 'object'}"`,
    );
    res.end(bytes);
  }
}

function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    json: 'application/json',
    txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}
