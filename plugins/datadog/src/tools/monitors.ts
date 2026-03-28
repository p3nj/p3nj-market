import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ddGet, handleApiError } from "../services/datadog.js";
import { CHARACTER_LIMIT, DEFAULT_LIMIT } from "../constants.js";
import { ResponseFormat, type MonitorEntry, type MonitorsResult } from "../types.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ListMonitorsInputSchema = z
  .object({
    name_filter: z
      .string()
      .optional()
      .describe(
        "Filter monitors whose name contains this string (case-insensitive, optional)"
      ),
    tags: z
      .string()
      .optional()
      .describe(
        'Comma-separated list of tags to filter monitors by, e.g. "env:prod,team:backend" (optional)'
      ),
    monitor_status: z
      .string()
      .optional()
      .describe(
        'Filter by current monitor status. Accepted values: "Alert", "Warn", "No Data", "OK", "Ignored", "Skipped" (optional, case-insensitive)'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum number of monitors to return (default: ${DEFAULT_LIMIT})`),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of monitors to skip for pagination (default: 0)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable (default) or "json" for structured data'
      ),
  })
  .strict();

type ListMonitorsInput = z.infer<typeof ListMonitorsInputSchema>;

// ---------------------------------------------------------------------------
// Datadog API response shape (v1 monitors)
// ---------------------------------------------------------------------------

interface DDMonitor {
  id?: number;
  name?: string;
  type?: string;
  overall_state?: string;
  query?: string;
  tags?: string[];
  created?: string;
  modified?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMonitorsMarkdown(result: MonitorsResult): string {
  const lines: string[] = [
    "# Datadog Monitors",
    "",
    `Showing **${result.count}** of ${result.total} monitor${result.total === 1 ? "" : "s"}${result.has_more ? " — use offset for more" : ""}.`,
    "",
  ];

  for (const m of result.monitors) {
    const status = m.status ?? "Unknown";
    const statusEmoji =
      status === "Alert" ? "🔴" : status === "Warn" ? "🟡" : status === "OK" ? "🟢" : "⚪";

    lines.push(`## ${statusEmoji} ${m.name ?? "Unnamed"} (ID: ${m.id ?? "?"})`);
    lines.push(`- **Status**: ${status}`);
    lines.push(`- **Type**: ${m.type ?? "—"}`);
    if (m.query) lines.push(`- **Query**: \`${m.query}\``);
    if (m.tags && m.tags.length > 0) lines.push(`- **Tags**: ${m.tags.join(", ")}`);
    if (m.modified) lines.push(`- **Last modified**: ${m.modified}`);
    lines.push("");
  }

  if (result.has_more && result.next_offset !== undefined) {
    lines.push(`> Use \`offset: ${result.next_offset}\` to see the next page.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerListMonitors(server: McpServer): void {
  server.registerTool(
    "datadog_list_monitors",
    {
      title: "List Datadog Monitors",
      description: `List Datadog monitors and their current status, with optional filtering.

This tool queries the Datadog Monitors v1 API. It does NOT write or delete any data.

Args:
  - name_filter (string): Case-insensitive substring to filter monitor names (optional)
  - tags (string): Comma-separated tags to filter by, e.g. "env:prod,team:backend" (optional)
  - monitor_status (string): Filter by status — "Alert", "Warn", "No Data", "OK", "Ignored", "Skipped" (optional)
  - limit (number): Max monitors to return (1–1000, default: 50)
  - offset (number): Monitors to skip for pagination (default: 0)
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns (JSON format):
{
  "total": number,             // Total monitors matching filters
  "count": number,             // Number of monitors in this response
  "has_more": boolean,         // Whether more results are available
  "next_offset": number,       // Offset for next page (when has_more is true)
  "monitors": [
    {
      "id": number,            // Monitor ID
      "name": string,          // Monitor name
      "type": string,          // Monitor type (e.g. "metric alert")
      "status": string,        // Current status (e.g. "Alert", "OK")
      "query": string,         // Monitor query
      "tags": string[],        // Associated tags
      "created": string,       // ISO-8601 creation timestamp
      "modified": string       // ISO-8601 last-modified timestamp
    }
  ]
}

Examples:
  - "Show all alerting monitors" → monitor_status="Alert"
  - "Find monitors tagged env:prod" → tags="env:prod"
  - "Search for CPU monitors" → name_filter="cpu"
  - "Paginate" → limit=20, offset=20

Error handling:
  - Returns "Error: Authentication failed" if credentials are invalid
  - Returns "No monitors found" if no monitors match the filters`,

      inputSchema: ListMonitorsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListMonitorsInput) => {
      try {
        const queryParams: Record<string, unknown> = {
          page_size: Math.min(params.limit, 1000),
          page: Math.floor(params.offset / params.limit),
        };
        if (params.name_filter) queryParams["name"] = params.name_filter;
        if (params.tags) queryParams["monitor_tags"] = params.tags;

        const raw = await ddGet<DDMonitor[]>("/api/v1/monitor", queryParams);

        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            content: [
              { type: "text", text: "No monitors found matching the given filters." },
            ],
          };
        }

        // Client-side status filter (Datadog API doesn't support filtering by overall_state directly)
        let monitors = raw;
        if (params.monitor_status) {
          const filterLower = params.monitor_status.toLowerCase();
          monitors = monitors.filter(
            (m) => (m.overall_state ?? "").toLowerCase().includes(filterLower)
          );
        }

        if (monitors.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No monitors found with status '${params.monitor_status}'.`,
              },
            ],
          };
        }

        const page = monitors.slice(0, params.limit);
        const totalFiltered = monitors.length;
        const hasMore = totalFiltered > params.offset + page.length;

        const entries: MonitorEntry[] = page.map((m) => ({
          id: m.id ?? null,
          name: m.name ?? null,
          type: m.type ?? null,
          status: m.overall_state ?? null,
          query: m.query ?? null,
          tags: m.tags ?? [],
          created: m.created ?? null,
          modified: m.modified ?? null,
        }));

        const result: MonitorsResult = {
          total: totalFiltered,
          count: entries.length,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + entries.length } : {}),
          monitors: entries,
        };

        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          text = formatMonitorsMarkdown(result);
        } else {
          text = JSON.stringify(result, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          const truncated = {
            ...result,
            monitors: result.monitors.slice(0, Math.max(1, Math.floor(result.monitors.length / 2))),
            truncated: true,
            truncation_message: `Response truncated. Use a smaller limit or add filters to narrow results.`,
          };
          text = JSON.stringify(truncated, null, 2);
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );
}
