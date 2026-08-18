import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ImportTokensInput, UpsertTokenInput } from '@brandlens/contracts';
import { QUEUES } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { QueueService } from '../queue/queue.service';
import { OntologyService } from './ontology.service';
import {
  CreateClaimInput,
  CreateDisclaimerInput,
  CreateDocumentInput,
  CreateLexiconTermInput,
  CreateLogoInput,
  CreateTypeStyleInput,
  CreateVoiceAttributeInput,
  InduceRulesInput,
  UpdateTypeStyleInput,
} from './ontology.dto';
import type { TenantContext } from '../database/tenant-context.service';

/** Nest's multipart file shape, without pulling Express.Multer into signatures. */
export interface UploadedFileLike {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

@ApiTags('ontology')
@ApiBearerAuth()
@Controller('v1/brands/:brandId')
export class OntologyController {
  constructor(
    private readonly ontology: OntologyService,
    private readonly queue: QueueService,
  ) {}

  /* ---------------------------------------------------------------- tokens */

  @Get('tokens')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'List design tokens (DTCG shape)' })
  listTokens(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listTokens(orgId, brandId);
  }

  @Post('tokens')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create or update a single design token' })
  upsertToken(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(UpsertTokenInput)) body: z.infer<typeof UpsertTokenInput>,
  ) {
    return this.ontology.upsertToken(orgId, brandId, body);
  }

  @Post('tokens/import')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Import tokens from DTCG, Style Dictionary, Figma Variables or Tailwind' })
  importTokens(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(ImportTokensInput)) body: z.infer<typeof ImportTokensInput>,
  ) {
    return this.ontology.importTokens(orgId, brandId, body);
  }

  @Delete('tokens/:id')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Delete a design token' })
  deleteToken(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('id') id: string) {
    return this.ontology.deleteToken(orgId, brandId, id);
  }

  /* ----------------------------------------------------------------- logos */

  @Get('logos')
  @ApiOperation({ summary: 'List logo variants with signed preview URLs' })
  listLogos(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listLogos(orgId, brandId);
  }

  @Post('logos')
  @Roles('brand_manager')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({ summary: 'Upload a logo variant and its usage constraints' })
  createLogo(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFile() file?: UploadedFileLike,
  ) {
    const parsed = CreateLogoInput.safeParse(coerceMultipart(rawBody));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message));
    return this.ontology.createLogo(orgId, brandId, parsed.data, file);
  }

  @Delete('logos/:id')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Delete a logo variant' })
  deleteLogo(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('id') id: string) {
    return this.ontology.deleteLogo(orgId, brandId, id);
  }

  /* ----------------------------------------------------------- type styles */

  @Get('type-styles')
  @ApiOperation({ summary: 'List type styles' })
  listTypeStyles(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listTypeStyles(orgId, brandId);
  }

  @Post('type-styles')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create a type style' })
  createTypeStyle(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateTypeStyleInput)) body: z.infer<typeof CreateTypeStyleInput>,
  ) {
    return this.ontology.createTypeStyle(orgId, brandId, body);
  }

  @Patch('type-styles/:id')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Update a type style' })
  updateTypeStyle(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Body(zodBody(UpdateTypeStyleInput)) body: z.infer<typeof UpdateTypeStyleInput>,
  ) {
    return this.ontology.updateTypeStyle(orgId, brandId, id, body);
  }

  @Delete('type-styles/:id')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Delete a type style' })
  deleteTypeStyle(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('id') id: string) {
    return this.ontology.deleteTypeStyle(orgId, brandId, id);
  }

  /* ----------------------------------------------------------------- voice */

  @Get('voice')
  @ApiOperation({ summary: 'List voice attributes' })
  listVoice(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listVoice(orgId, brandId);
  }

  @Post('voice')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create a voice attribute (we-are / we-are-not + exemplars)' })
  createVoice(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateVoiceAttributeInput)) body: z.infer<typeof CreateVoiceAttributeInput>,
  ) {
    return this.ontology.createVoice(orgId, brandId, body);
  }

  /* --------------------------------------------------------------- lexicon */

  @Get('lexicon')
  @ApiOperation({ summary: 'List lexicon terms' })
  listLexicon(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listLexicon(orgId, brandId);
  }

  @Post('lexicon')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Add a banned / required / preferred / trademark term' })
  createLexicon(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateLexiconTermInput)) body: z.infer<typeof CreateLexiconTermInput>,
  ) {
    return this.ontology.createLexiconTerm(orgId, brandId, body);
  }

  /* ---------------------------------------------------------------- claims */

  @Get('claims')
  @ApiOperation({ summary: 'List the claims register' })
  listClaims(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listClaims(orgId, brandId);
  }

  @Post('claims')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Register an approved claim with substantiation and expiry' })
  createClaim(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateClaimInput)) body: z.infer<typeof CreateClaimInput>,
  ) {
    return this.ontology.createClaim(orgId, brandId, body);
  }

  /* ----------------------------------------------------------- disclaimers */

  @Get('disclaimers')
  @ApiOperation({ summary: 'List disclaimers' })
  listDisclaimers(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listDisclaimers(orgId, brandId);
  }

  @Post('disclaimers')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create a disclaimer with size / contrast / proximity requirements' })
  createDisclaimer(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateDisclaimerInput)) body: z.infer<typeof CreateDisclaimerInput>,
  ) {
    return this.ontology.createDisclaimer(orgId, brandId, body);
  }

  /* ------------------------------------------------------------- documents */

  @Get('documents')
  @ApiOperation({ summary: 'List brand documents' })
  listDocuments(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.listDocuments(orgId, brandId);
  }

  @Post('documents')
  @Roles('brand_manager')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a brand book or guideline document' })
  async createDocument(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFile() file?: UploadedFileLike,
  ) {
    if (!file) throw new BadRequestException('multipart field `file` is required');
    const parsed = CreateDocumentInput.safeParse(coerceMultipart(rawBody));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message));
    return this.ontology.createDocument(orgId, brandId, { name: parsed.data.name ?? '', kind: parsed.data.kind }, file);
  }

  /**
   * Extraction is asynchronous and always produces `status: 'proposed'` rules.
   * A brand book is 120 pages of vision-model work; making the caller wait for
   * it would guarantee a gateway timeout on the most important onboarding step.
   */
  @Post('documents/:docId/extract')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Extract proposed rules and tokens from a document' })
  async extractDocument(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Param('docId') docId: string,
  ) {
    const doc = await this.ontology.getDocument(orgId, brandId, docId);
    await this.queue.enqueue(
      QUEUES.extractBrandDocument,
      { orgId, brandId, documentId: docId, requestedByUserId: user.userId ?? null },
      { singletonKey: `extract:${docId}` },
    );
    return { documentId: doc.id, status: 'queued', message: 'Extraction queued; rules will arrive as `proposed`.' };
  }

  @Get('documents/:docId/chunks')
  @ApiOperation({ summary: 'Layout-aware chunks of a parsed document (citation source)' })
  async documentChunks(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('docId') docId: string) {
    await this.ontology.getDocument(orgId, brandId, docId);
    return this.ontology.documentChunks(orgId, docId);
  }

  /* ----------------------------------------------------------- image style */

  @Get('image-style')
  @ApiOperation({ summary: 'The learned image style profile for this brand' })
  imageStyle(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    return this.ontology.getImageStyleProfile(orgId, brandId);
  }

  /* ---------------------------------------------------------- rule induction */

  /**
   * Induction measures the approved corpus to find the rules the team actually
   * enforces, as opposed to the ones they wrote down. Output is `proposed`.
   */
  @Post('induce-rules')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Induce proposed rules by measuring the approved corpus' })
  async induceRules(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Body(zodBody(InduceRulesInput)) body: z.infer<typeof InduceRulesInput>,
  ) {
    await this.queue.enqueue(
      QUEUES.induceRules,
      { orgId, brandId, ...body, requestedByUserId: user.userId ?? null },
      { singletonKey: `induce:${brandId}` },
    );
    return { brandId, status: 'queued', message: 'Induction queued; rules will arrive as `proposed`.' };
  }
}

/**
 * multipart/form-data delivers every field as a string. Coercing the handful
 * of JSON-shaped fields here keeps the zod schemas honest instead of making
 * every numeric field a string union.
 */
function coerceMultipart(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    const trimmed = v.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        out[k] = JSON.parse(trimmed);
        continue;
      } catch {
        /* fall through to the raw string */
      }
    }
    out[k] = v;
  }
  return out;
}
