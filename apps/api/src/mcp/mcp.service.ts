import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CreateCheckInput } from '@brandlens/contracts';
import { ChecksService } from '../checks/checks.service';
import { FindingsService } from '../checks/findings.service';
import { RulesetCompilerService } from '../rulesets/ruleset-compiler.service';
import { BrandsService } from '../brands/brands.service';
import type { TenantContext } from '../database/tenant-context.service';

/* ==========================================================================
 * MCP surface.
 *
 * Agents in a generate → verify → fix loop are the fastest-growing consumer of
 * a verification API, so this is a first-class surface rather than a demo. The
 * three tools are deliberately the minimum an agent needs to close the loop:
 * check the thing it made, read the rules it must satisfy, and understand why
 * a specific finding fired so it can fix it rather than guess.
 * ========================================================================== */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const CheckAssetArgs = z.object({
  assetId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  /** Inline copy submission — lets an agent verify text it just generated. */
  copy: z.record(z.string()).optional(),
  name: z.string().optional(),
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
  dimensions: z.array(z.string()).optional(),
  deterministicOnly: z.boolean().optional(),
});

const GetBrandRulesArgs = z.object({
  brandId: z.string().uuid(),
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
  dimension: z.string().optional(),
});

const ExplainFindingArgs = z.object({ findingId: z.string().uuid() });

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'check_asset',
    description:
      'Run a brand-compliance check and return structured findings with severities, measured values, thresholds and bounding boxes. Pass an assetId, or inline `copy` to check text you just generated. Returns synchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Existing asset id (uuid)' },
        brandId: { type: 'string', description: 'Brand to check against (uuid)' },
        copy: { type: 'object', description: 'Inline copy fields, e.g. {"headline":"…","body":"…"}' },
        name: { type: 'string' },
        market: { type: 'string', description: 'e.g. de-DE' },
        channel: { type: 'string', description: 'e.g. meta-feed' },
        assetType: { type: 'string' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Restrict to specific dimensions' },
        deterministicOnly: { type: 'boolean', description: 'Skip the vision judge — fast and free' },
      },
    },
  },
  {
    name: 'get_brand_rules',
    description:
      'Return the effective, fully-resolved rules for a brand in a given market/channel context, so generation can satisfy them up front instead of failing verification afterwards.',
    inputSchema: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string' },
        market: { type: 'string' },
        channel: { type: 'string' },
        assetType: { type: 'string' },
        dimension: { type: 'string' },
      },
    },
  },
  {
    name: 'explain_finding',
    description:
      'Explain one finding: the rule text, the citation back to the brand book, the measured value against its threshold, and how similar cases were decided before.',
    inputSchema: { type: 'object', required: ['findingId'], properties: { findingId: { type: 'string' } } },
  },
];

@Injectable()
export class McpService {
  constructor(
    private readonly checks: ChecksService,
    private readonly findings: FindingsService,
    private readonly compiler: RulesetCompilerService,
    private readonly brands: BrandsService,
  ) {}

  async handle(user: TenantContext, request: McpRequest): Promise<McpResponse> {
    const id = request.id ?? null;
    try {
      switch (request.method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'brandlens', version: '0.1.0' },
          });
        case 'tools/list':
          return ok(id, { tools: MCP_TOOLS });
        case 'tools/call':
          return ok(id, await this.callTool(user, request.params ?? {}));
        case 'ping':
          return ok(id, {});
        default:
          return err(id, -32601, `Unknown method: ${request.method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // MCP clients expect tool failures as content, not as transport errors —
      // an agent can act on "no active ruleset" but not on a 500.
      return ok(id, { isError: true, content: [{ type: 'text', text: message }] });
    }
  }

  private async callTool(user: TenantContext, params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'check_asset':
        return this.checkAsset(user, CheckAssetArgs.parse(args));
      case 'get_brand_rules':
        return this.getBrandRules(user, GetBrandRulesArgs.parse(args));
      case 'explain_finding':
        return this.explainFinding(user, ExplainFindingArgs.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async checkAsset(user: TenantContext, args: z.infer<typeof CheckAssetArgs>): Promise<unknown> {
    const input: z.infer<typeof CreateCheckInput> = {
      assetId: args.assetId,
      brandId: args.brandId,
      asset: args.assetId
        ? undefined
        : {
            brandId: args.brandId ?? '',
            name: args.name ?? 'agent-submission',
            kind: 'copy' as const,
            copyFields: args.copy ?? {},
            market: args.market,
            channel: args.channel,
            assetType: args.assetType,
          },
      dimensions: args.dimensions as z.infer<typeof CreateCheckInput>['dimensions'],
      deterministicOnly: args.deterministicOnly ?? false,
      // Agents cannot poll. Synchronous is the only useful mode here.
      async: false,
      force: false,
    };

    const result = await this.checks.create(user.orgId, user.userId, input, { triggeredBy: 'mcp' });
    const run = result.run as { id: string; score: number | null; scoreBand: string | null; hasBlocker: boolean };
    const detail = 'findings' in result.run ? result.run : await this.checks.detail(user.orgId, run.id);

    return {
      content: [
        {
          type: 'text',
          text: summariseForAgent(detail),
        },
      ],
      structuredContent: {
        checkRunId: detail.id,
        score: detail.score,
        scoreBand: detail.scoreBand,
        hasBlocker: detail.hasBlocker,
        coverageRate: detail.coverageRate,
        findings: detail.findings.map((f) => ({
          id: f.id,
          ruleKey: f.ruleKey,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          bbox: f.bbox,
          status: f.status,
        })),
      },
    };
  }

  private async getBrandRules(user: TenantContext, args: z.infer<typeof GetBrandRulesArgs>): Promise<unknown> {
    await this.brands.requireBrand(user.orgId, args.brandId);
    const effective = await this.compiler.effective(user.orgId, args.brandId, {
      market: args.market,
      channel: args.channel,
      assetType: args.assetType,
    });

    const rules = args.dimension ? effective.rules.filter((r) => r.dimension === args.dimension) : effective.rules;

    return {
      content: [
        {
          type: 'text',
          text: rules.length
            ? rules.map((r) => `[${r.severity}] ${r.dimension}/${r.key}: ${r.statement}`).join('\n')
            : 'No active rules apply to this context. Publish a ruleset first.',
        },
      ],
      structuredContent: {
        rulesetHash: effective.hash,
        context: effective.context,
        scoringConfig: effective.scoringConfig,
        rules: rules.map((r) => ({
          key: r.key,
          version: r.version,
          statement: r.statement,
          rationale: r.rationale,
          dimension: r.dimension,
          severity: r.severity,
          tier: r.tier,
          check: r.check,
          citation: r.citation,
        })),
      },
    };
  }

  private async explainFinding(user: TenantContext, args: z.infer<typeof ExplainFindingArgs>): Promise<unknown> {
    const explained = await this.findings.explain(user.orgId, args.findingId);
    const evidence = (explained.trace?.evidence ?? {}) as {
      measured?: Record<string, unknown>;
      threshold?: Record<string, unknown>;
      observation?: string;
    };

    const lines = [
      `Rule: ${explained.finding.ruleKey}`,
      `Verdict: ${explained.trace?.verdict ?? 'unknown'} (severity ${explained.finding.severity})`,
      explained.finding.title,
    ];
    if (evidence.observation) lines.push(`Observed: ${evidence.observation}`);
    if (evidence.measured) lines.push(`Measured: ${JSON.stringify(evidence.measured)}`);
    if (evidence.threshold) lines.push(`Threshold: ${JSON.stringify(evidence.threshold)}`);
    if (explained.trace?.citation) lines.push(`Citation: ${JSON.stringify(explained.trace.citation)}`);
    if (explained.trace?.suggestedFix) lines.push(`Suggested fix: ${explained.trace.suggestedFix}`);
    if (explained.priorDecisions.length) {
      lines.push(
        `Prior human decisions on this rule: ${explained.priorDecisions
          .slice(0, 3)
          .map((d) => `${d.action}${d.rationale ? ` (“${d.rationale.slice(0, 120)}”)` : ''}`)
          .join('; ')}`,
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        finding: explained.finding,
        evidence,
        citation: explained.trace?.citation ?? null,
        precedentAssetIds: explained.trace?.precedentAssetIds ?? [],
        suggestedFix: explained.trace?.suggestedFix ?? null,
        priorDecisions: explained.priorDecisions.map((d) => ({
          action: d.action,
          rationale: d.rationale,
          createdAt: d.createdAt,
        })),
      },
    };
  }
}

function summariseForAgent(detail: {
  score: number | null;
  scoreBand: string | null;
  hasBlocker: boolean;
  findings: Array<{ severity: string; title: string; detail: string | null; ruleKey: string }>;
}): string {
  const head = `Score ${detail.score ?? 'n/a'} (${detail.scoreBand ?? 'unscored'})${detail.hasBlocker ? ' — BLOCKER present, this asset cannot ship' : ''}`;
  if (detail.findings.length === 0) return `${head}\nNo findings. The asset is compliant with the active ruleset.`;

  const bySeverity = ['blocker', 'major', 'minor', 'advisory'];
  const sorted = [...detail.findings].sort(
    (a, b) => bySeverity.indexOf(a.severity) - bySeverity.indexOf(b.severity),
  );
  return [
    head,
    ...sorted.map((f) => `- [${f.severity}] ${f.ruleKey}: ${f.title}${f.detail ? `\n  ${f.detail.replace(/\n/g, '\n  ')}` : ''}`),
  ].join('\n');
}

function ok(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
