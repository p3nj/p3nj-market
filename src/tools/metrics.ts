import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ddGet, handleApiError } from "../services/datadog.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, type MetricSeries, type MetricsResult } from "../types.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const QueryMetricsInputSchema = z
  .object({
    metric_query: z
      .string()
      .min(1)
      .describe(
        'Datadog metrics query string, e.g. "avg:system.cpu.user{service:api}", "sum:nginx.requests{env:prod} by {host}"'
      ),
    from_time: z
      .number()
      .int()
      .optional()
      .describe(
        "Unix epoch start time in seconds. If omitted, defaults to from_minutes_ago minutes before now."
      ),
    to_time: z
      .number()
      .int()
      .optional()
      .describe("Unix epoch end time in seconds. Defaults to now."),
    from_minutes_ago: z
      .number()
      .int()
      .min(1)
      .max(43200)
      .default(60)
      .describe(
        "How many minutes back to query when from_time is not supplied (default: 60, max: 43200 = 30 days)"
      ),
    max_points_per_series: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        "Maximum number of data points to include per series (default: 100). The most recent points are kept."
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable (default) or "json" for structured data'
      ),
  })
  .strict();

type QueryMetricsInput = z.infer<typeof QueryMetricsInputSchema>;

// ---------------------------------------------------------------------------
// Datadog API response shape (v1 metrics query)
// ---------------------------------------------------------------------------

interface DDMetricsResponse {
  series?: Array<{
    metric?: string;
    scope?: string;
    unit?: Array<{ name?: string } | null> | null;
    pointlist?: Array<[number, number | null]>;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMetricsMarkdown(result: MetricsResult, query: string): string {
  const lines: string[] = [
    `# Datadog Metrics: \`${query}\``,
    "",
    `Found **${result.count}** series.`,
    "",
  ];

  for (const series of result.series) {
    lines.push(`## ${series.metric ?? "unknown"}`);
    if (series.scope) lines.push(`- **Scope**: \`${series.scope}\``);
    if (series.unit) lines.push(`- **Unit**: ${series.unit}`);
    lines.push(`- **Data points**: ${series.num_points}`);
    if (series.latest_value !== null) {
      lines.push(`- **Latest value**: ${series.latest_value}`);
    }
    if (series.points.length > 0) {
      lines.push("- **Recent points** (timestamp → value):");
      for (const pt of series.points.slice(-10)) {
        const dt = new Date(pt.timestamp * 1000).toISOString();
        lines.push(`  - ${dt}: ${pt.value ?? "null"}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerQueryMetrics(server: McpServer): void {
  server.registerTool(
    "datadog_query_metrics",
    {
      title: "Query Datadog Metrics",
      description: `Fetch timeseries metric data from Datadog using a metrics query string.

This tool queries the Datadog Metrics v1 API. It does NOT write or delete any data.

Args:
  - metric_query (string): Datadog metrics query, e.g. "avg:system.cpu.user{service:api}"
  - from_time (number): Unix epoch start time in seconds (optional, overrides from_minutes_ago)
  - to_time (number): Unix epoch end time in seconds (optional, defaults to now)
  - from_minutes_ago (number): Minutes back to query when from_time is omitted (default: 60)
  - max_points_per_series (number): Max data points per series to return (1–500, default: 100)
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns (JSON format):
{
  "count": number,           // Number of series returned
  "series": [
    {
      "metric": string,      // Metric name, e.g. "system.cpu.user"
      "scope": string,       // Tag scope, e.g. "service:api"
      "unit": string,        // Unit of measurement (e.g. "percent")
      "num_points": number,  // Total number of data points in series
      "latest_value": number,// Most recent value
      "points": [
        { "timestamp": number, "value": number }
      ]
    }
  ]
}

Examples:
  - "CPU usage on prod servers last hour" → metric_query="avg:system.cpu.user{env:prod}", from_minutes_ago=60
  - "Memory usage by host" → metric_query="avg:system.mem.used{*} by {host}"
  - "Specific 2-hour window" → from_time=1700000000, to_time=1700007200

Error handling:
  - Returns "Error: Authentication failed" if credentials are invalid
  - Returns "No metric data found" if the query yields no series`,

      inputSchema: QueryMetricsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: QueryMetricsInput) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const toTime = params.to_time ?? now;
        const fromTime = params.from_time ?? now - params.from_minutes_ago * 60;

        const raw = await ddGet<DDMetricsResponse>("/api/v1/query", {
          from: fromTime,
          to: toTime,
          query: params.metric_query,
        });

        const rawSeries = raw.series ?? [];

        if (rawSeries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No metric data found for query: '${params.metric_query}'.`,
              },
            ],
          };
        }

        const series: MetricSeries[] = rawSeries.map((s) => {
          const points = s.pointlist ?? [];
          const trimmed = points.slice(-params.max_points_per_series);
          const unit =
            Array.isArray(s.unit) && s.unit.length > 0
              ? (s.unit[0]?.name ?? null)
              : null;
          return {
            metric: s.metric ?? null,
            scope: s.scope ?? null,
            unit,
            num_points: points.length,
            latest_value: points.length > 0 ? (points[points.length - 1][1] ?? null) : null,
            points: trimmed.map(([ts, val]) => ({
              timestamp: Math.floor(ts / 1000),
              value: val,
            })),
          };
        });

        const result: MetricsResult = {
          count: series.length,
          series,
        };

        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          text = formatMetricsMarkdown(result, params.metric_query);
        } else {
          text = JSON.stringify(result, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          const truncatedSeries = result.series.map((s) => ({
            ...s,
            points: s.points.slice(-10),
          }));
          text = JSON.stringify(
            {
              count: result.count,
              series: truncatedSeries,
              truncated: true,
              truncation_message:
                "Data points per series were trimmed to 10. Use max_points_per_series to control output size.",
            },
            null,
            2
          );
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
