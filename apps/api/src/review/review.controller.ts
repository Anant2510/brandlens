import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ReviewDecisionInput, SubmitReviewInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { PageQuery } from '../common/pagination';
import { ReviewService } from './review.service';
import type { TenantContext } from '../database/tenant-context.service';

const ListQuery = PageQuery.extend({
  state: z.enum(['pending', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn']).optional(),
  stage: z.string().optional(),
  assignedToUserId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  overdue: z.coerce.boolean().optional(),
});

const CreateReviewInput = z.object({
  assetId: z.string().uuid(),
  checkRunId: z.string().uuid().optional(),
  stage: z.enum(['creative', 'brand', 'legal', 'marketing_ops']).optional(),
  assignedToUserId: z.string().uuid().optional(),
  dueAt: z.string().optional(),
});

const AssignInput = z.object({ assigneeUserId: z.string().uuid() });

@ApiTags('reviews')
@ApiBearerAuth()
@Controller('v1/reviews')
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'stage', required: false })
  @ApiQuery({ name: 'overdue', required: false, type: Boolean })
  @ApiOperation({ summary: 'List review queue items' })
  list(@OrgId() orgId: string, @Query() query: Record<string, string>) {
    return this.reviews.list(orgId, ListQuery.parse(query));
  }

  @Post()
  @Roles('reviewer')
  @ApiOperation({ summary: 'Open a review (multi-stage MLR-style gate)' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateReviewInput)) body: z.infer<typeof CreateReviewInput>,
  ) {
    return this.reviews.create(orgId, user.userId, body);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch a review with its asset, run, findings and decisions' })
  get(@OrgId() orgId: string, @Param('id') id: string) {
    return this.reviews.get(orgId, id);
  }

  @Post(':id/assign')
  @Roles('reviewer')
  @ApiOperation({ summary: 'Assign a review to a reviewer' })
  assign(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('id') id: string,
    @Body(zodBody(AssignInput)) body: z.infer<typeof AssignInput>,
  ) {
    return this.reviews.assign(orgId, user.userId, id, body.assigneeUserId);
  }

  @Post(':id/decision')
  @Roles('reviewer')
  @ApiOperation({ summary: 'Record a decision within a review' })
  decide(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('id') id: string,
    @Body(zodBody(ReviewDecisionInput)) body: z.infer<typeof ReviewDecisionInput>,
  ) {
    return this.reviews.decide(orgId, user.userId, id, body);
  }

  @Post(':id/submit')
  @Roles('reviewer')
  @ApiOperation({ summary: 'Close a review with an approval decision' })
  submit(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('id') id: string,
    @Body(zodBody(SubmitReviewInput)) body: z.infer<typeof SubmitReviewInput>,
  ) {
    return this.reviews.submit(orgId, user.userId, id, body);
  }
}
