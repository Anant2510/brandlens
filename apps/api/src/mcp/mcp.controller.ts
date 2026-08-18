import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Scopes } from '../auth/decorators/roles.decorator';
import { MCP_TOOLS, McpService, type McpRequest, type McpResponse } from './mcp.service';
import type { TenantContext } from '../database/tenant-context.service';

/**
 * A single JSON-RPC endpoint speaking the MCP shape.
 *
 * Authentication reuses the normal bearer scheme, so an agent points its MCP
 * client at this URL with the tenant's `bl_live_…` key and gets verification
 * as a tool with no extra plumbing.
 */
@ApiTags('mcp')
@ApiBearerAuth()
@Controller('v1/mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post()
  @HttpCode(200)
  @Scopes('checks:write')
  @ApiOperation({ summary: 'MCP JSON-RPC: tools/list and tools/call' })
  @ApiBody({
    schema: {
      type: 'object',
      example: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'check_asset', arguments: { brandId: '…', copy: { headline: 'Best bank ever' } } },
      },
    },
  })
  handle(@CurrentUser() user: TenantContext, @Body() body: McpRequest | McpRequest[]): Promise<McpResponse | McpResponse[]> {
    // JSON-RPC batching: MCP clients send arrays when pipelining tool calls.
    if (Array.isArray(body)) return Promise.all(body.map((r) => this.mcp.handle(user, r)));
    return this.mcp.handle(user, body);
  }

  @Get('tools')
  @Scopes('checks:read')
  @ApiOperation({ summary: 'Tool manifest (convenience mirror of tools/list)' })
  tools() {
    return { tools: MCP_TOOLS };
  }
}
