#!/usr/bin/env node
/**
 * Datadog MCP Server  (v2.0.0)
 *
 * Generic Datadog integration — not tied to any specific service.
 * Exposes core Datadog Logs API functionality as MCP tools with full attribute passthrough.
 *
 * v2.0.0 changes:
 *   - Added cursor-based pagination support (cursor input + next_cursor output)
 *   - Callers can now page through millions of logs by passing next_cursor back
 *
 * Compliant with MCP best practices:
 *   - McpServer + registerTool (modern API)
 *   - Zod input validation with .strict()
 *   - Tool annotations (readOnlyHint, etc.)
 *   - CHARACTER_LIMIT truncation
 *   - Actionable error messages
 *   - Startup credential validation
 *   - response_format support (json / markdown)
 *
 * Tools:
 *   1. datadog_query_logs       — Search logs with full attribute passthrough + cursor pagination.
 *   2. datadog_aggregate_logs   — Aggregate log counts grouped by any facet.
 *   3. datadog_list_log_facets  — Discover available facets/attributes from a sample of logs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// ── Constants ──────────────────────────────────────────────────────────────
const CHARACTER_LIMIT = 80_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// ── Credentials (from connector environment variables) ─────────────────────
const DD_API_KEY = process.env.DD_API_KEY || '';
const DD_APP_KEY = process.env.DD_APP_KEY || '';
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';

// ── Startup validation ─────────────────────────────────────────────────────
if (!DD_API_KEY || !DD_APP_KEY) {
  console.error(
    'ERROR: DD_API_KEY and DD_APP_KEY environment variables are required.\n'
    + 'Configure these in your connector settings.'
  );
  process.exit(1);
}

// ── Datadog API helpers ────────────────────────────────────────────────────
async function ddPost(path, body) {
  const resp = await fetch(`https://api.${DD_SITE}${path}`, {
    method: 'POST',
    headers: {
      'DD-API-KEY': DD_API_KEY,
      'DD-APPLICATION-KEY': DD_APP_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    switch (resp.status) {
      case 401:
        throw new Error('Datadog authentication failed (401). Check that DD_API_KEY and DD_APP_KEY are valid and not expired.');
      case 403:
        throw new Error("Datadog permission denied (403). Ensure the API/App key pair has 'logs_read_data' scope.");
      case 429:
        throw new Error('Datadog rate limit exceeded (429). Wait a moment and retry with a smaller time range or lower limit.');
      default:
        throw new Error(`Datadog API error ${resp.status}: ${text.slice(0, 300)}`);
    }
  }
  return resp.json();
}

// ── Flatten a raw Datadog log entry into a single-level object ─────────────
function flattenLog(raw) {
  const topAttrs = raw.attributes || {};
  const nested = topAttrs.attributes || {};

  return {
    id: raw.id || null,
    timestamp: topAttrs.timestamp || null,
    status: (topAttrs.status || '').toLowerCase(),
    message: topAttrs.message || '',
    service: topAttrs.service || '',
    host: topAttrs.host || null,
    tags: topAttrs.tags || [],
    ...nested,
  };
}

// ── Truncation helper ──────────────────────────────────────────────────────
function truncateResponse(result) {
  const text = JSON.stringify(result);
  if (text.length <= CHARACTER_LIMIT) return text;

  if (result.logs && Array.isArray(result.logs)) {
    const halfCount = Math.max(1, Math.floor(result.logs.length / 2));
    result.logs = result.logs.slice(0, halfCount);
    result.truncated = true;
    result.truncation_message =
      `Response truncated from ${result.total} to ${halfCount} log entries to stay within size limits. `
      + 'Use cursor-based pagination to fetch remaining entries, or add filters to narrow results.';
    const recheck = JSON.stringify(result);
    if (recheck.length <= CHARACTER_LIMIT) return recheck;
    result.logs = [];
    result.truncation_message += ' All log entries removed — only summary returned. Narrow your query.';
  }

  return JSON.stringify(result);
}

// ── Markdown formatters ────────────────────────────────────────────────────
function queryResultToMarkdown(result) {
  const lines = [
    `# Datadog Log Query Results`,
    '',
    `**Query:** \`${result.query}\``,
    `**Time:** ${result.from_time} → ${result.to_time}`,
    `**Total:** ${result.total} logs${result.truncated ? ' (truncated)' : ''}`,
    '',
  ];

  if (result.summary?.by_status && Object.keys(result.summary.by_status).length > 0) {
    lines.push('## Status Breakdown', '');
    for (const [status, count] of Object.entries(result.summary.by_status).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${status}**: ${count}`);
    }
    lines.push('');
  }

  if (result.logs?.length > 0) {
    lines.push('## Log Entries', '');
    for (const log of result.logs.slice(0, 50)) {
      lines.push(`**[${log.timestamp}]** \`${log.status}\` (${log.service})`);
      lines.push(`${log.message.slice(0, 300)}${log.message.length > 300 ? '...' : ''}`);
      lines.push('');
    }
    if (result.logs.length > 50) {
      lines.push(`_...and ${result.logs.length - 50} more entries_`);
    }
  }

  if (result.truncation_message) {
    lines.push('', `> ⚠️ ${result.truncation_message}`);
  }

  return lines.join('\n');
}

function aggregateResultToMarkdown(result) {
  const lines = [
    '# Datadog Log Aggregation',
    '',
    `**Query:** \`${result.query}\``,
    `**Time:** ${result.from_time} → ${result.to_time}`,
    `**Grouped by:** ${result.group_by}`,
    '',
    '## Results', '',
  ];

  for (const [key, count] of Object.entries(result.buckets).sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${key}**: ${count}`);
  }

  if (Object.keys(result.buckets).length === 0) {
    lines.push('_No results found._');
  }

  return lines.join('\n');
}

// ── Zod Schemas ────────────────────────────────────────────────────────────
const ResponseFormatEnum = z.enum(['json', 'markdown']).default('json')
  .describe("Output format: 'json' for structured data, 'markdown' for human-readable text.");

const QueryLogsSchema = z.object({
  query: z.string()
    .min(1, 'Query must not be empty. Use "*" to match all logs, or a Datadog log search query like "@service:MyApp status:error".')
    .max(2000, 'Query must not exceed 2000 characters')
    .describe('Datadog log search query. Examples: "@service:Prismatic RH99", "status:error @http.status_code:500". Use Datadog log search syntax.'),
  from_time: z.string()
    .default('now-1h')
    .describe('Start of time range. Supports relative values like "now-1h", "now-30m", "now-24h", or ISO 8601 timestamps.'),
  to_time: z.string()
    .default('now')
    .describe('End of time range. Supports relative values like "now" or ISO 8601 timestamps.'),
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Max log entries per page (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}). Use cursor pagination to fetch more.`),
  sort: z.enum(['timestamp', '-timestamp']).default('-timestamp')
    .describe('Sort order: "-timestamp" for newest first (default), "timestamp" for oldest first.'),
  cursor: z.string()
    .optional()
    .describe('Pagination cursor from a previous response (next_cursor field). Pass this to fetch the next page of results.'),
  response_format: ResponseFormatEnum,
}).strict();

const AggregateLogsSchema = z.object({
  query: z.string()
    .min(1, 'Query must not be empty.')
    .max(2000)
    .describe('Datadog log search query, same syntax as datadog_query_logs.'),
  from_time: z.string()
    .default('now-1h')
    .describe('Start of time range. Relative ("now-1h") or ISO 8601.'),
  to_time: z.string()
    .default('now')
    .describe('End of time range. Relative ("now") or ISO 8601.'),
  group_by: z.string()
    .min(1)
    .default('status')
    .describe('Facet to group by. Examples: "status", "@service", "@http.status_code", "@instanceId", "@flow", "@step".'),
  response_format: ResponseFormatEnum,
}).strict();

const ListFacetsSchema = z.object({
  query: z.string()
    .min(1)
    .max(2000)
    .describe('Datadog log search query to scope which logs to inspect for attributes.'),
  from_time: z.string()
    .default('now-1h')
    .describe('Start of time range.'),
  to_time: z.string()
    .default('now')
    .describe('End of time range.'),
  sample_size: z.number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Number of log entries to sample for discovering attributes (default: 3).'),
  response_format: ResponseFormatEnum,
}).strict();

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'datadog-mcp-server',
  version: '2.0.0',
});

// ── Tool: datadog_query_logs ───────────────────────────────────────────────
server.registerTool(
  'datadog_query_logs',
  {
    title: 'Query Datadog Logs',
    description:
      `Search Datadog logs and return matching entries with ALL attributes (including nested/custom attributes).

Supports cursor-based pagination: when has_more is true, pass the next_cursor value back to fetch the next page. This lets you iterate through millions of logs.

Use standard Datadog log search syntax for the query parameter. Common patterns:
  - "@service:Prismatic RH99" — logs from Prismatic service matching "RH99"
  - "status:error" — all error-level logs
  - "@http.status_code:>=400" — HTTP errors

Pagination example:
  1. First call: query="@service:Prismatic RH99 status:error", limit=900
  2. Response has has_more=true, next_cursor="abc123"
  3. Next call: same query + cursor="abc123"
  4. Repeat until has_more=false`,
    inputSchema: QueryLogsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const pageOpts = { limit: Math.min(params.limit, MAX_LIMIT) };

      if (params.cursor) {
        pageOpts.cursor = params.cursor;
      }

      const data = await ddPost('/api/v2/logs/events/search', {
        filter: { query: params.query, from: params.from_time, to: params.to_time },
        sort: params.sort,
        page: pageOpts,
      });

      const batch = data.data || [];
      const nextCursor = data.meta?.page?.after || null;

      const logs = batch.map(flattenLog);

      const statusCounts = {};
      for (const l of logs) {
        statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
      }

      const result = {
        query: params.query,
        from_time: params.from_time,
        to_time: params.to_time,
        total: logs.length,
        truncated: false,
        has_more: !!nextCursor && batch.length >= pageOpts.limit,
        next_cursor: nextCursor,
        summary: { by_status: statusCounts },
        logs,
      };

      const text = params.response_format === 'markdown'
        ? queryResultToMarkdown(result)
        : truncateResponse(result);

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: datadog_aggregate_logs ───────────────────────────────────────────
server.registerTool(
  'datadog_aggregate_logs',
  {
    title: 'Aggregate Datadog Logs',
    description:
      `Count Datadog logs grouped by a facet. Returns bucket counts without fetching individual log entries — fast and efficient for understanding log volume and distribution.

Use this to answer questions like:
  - "How many errors vs warnings in RH99?" → query="@service:Prismatic RH99", group_by="status"
  - "Which services are logging the most?" → query="*", group_by="@service"`,
    inputSchema: AggregateLogsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const data = await ddPost('/api/v2/logs/analytics/aggregate', {
        compute: [{ aggregation: 'count', type: 'total', metric: 'count' }],
        filter: { query: params.query, from: params.from_time, to: params.to_time },
        group_by: [{ facet: params.group_by }],
      });

      const buckets = {};
      let total = 0;
      for (const b of (data.data?.buckets || [])) {
        const key = b.by?.[params.group_by.replace('@', '')] || b.by?.status || '?';
        const count = b.computes?.c0 || 0;
        buckets[key] = count;
        total += count;
      }

      const result = {
        query: params.query,
        from_time: params.from_time,
        to_time: params.to_time,
        group_by: params.group_by,
        buckets,
        total,
      };

      const text = params.response_format === 'markdown'
        ? aggregateResultToMarkdown(result)
        : JSON.stringify(result);

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: datadog_list_log_facets ──────────────────────────────────────────
server.registerTool(
  'datadog_list_log_facets',
  {
    title: 'Discover Log Attributes',
    description:
      `Sample a few log entries and list all available attributes/facets. Useful for discovering what fields exist before building more targeted queries.`,
    inputSchema: ListFacetsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const data = await ddPost('/api/v2/logs/events/search', {
        filter: { query: params.query, from: params.from_time, to: params.to_time },
        sort: '-timestamp',
        page: { limit: params.sample_size },
      });

      const rawLogs = data.data || [];
      const flatLogs = rawLogs.map(flattenLog);

      const attrExamples = {};
      for (const log of flatLogs) {
        for (const [key, val] of Object.entries(log)) {
          if (val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
            if (!attrExamples[key]) {
              attrExamples[key] = typeof val === 'object' ? JSON.stringify(val).slice(0, 100) : String(val).slice(0, 100);
            }
          }
        }
      }

      const result = {
        query: params.query,
        sample_size: flatLogs.length,
        attributes: Object.keys(attrExamples).sort(),
        attribute_examples: attrExamples,
        sample_logs: flatLogs,
      };

      if (params.response_format === 'markdown') {
        const lines = [
          '# Discovered Log Attributes',
          '',
          `**Query:** \`${params.query}\``,
          `**Sample size:** ${flatLogs.length}`,
          '',
          '## Attributes', '',
        ];
        for (const [attr, example] of Object.entries(attrExamples).sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`- **${attr}**: \`${example}\``);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Start server ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('datadog-mcp-server v2.0.0 running via stdio');
