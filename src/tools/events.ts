import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ddGet, handleApiError } from "../services/datadog.js";
import { CHARACTER_LIMIT, DEFAULT_LIMIT } from "../constants.js";
import { ResponseFormat, type EventEntry, type EventsResult } from "../types.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ListEventsInputSchema = z
  .object({
    from_time: z
      .number()
      .int()
      .optional()
      .describe(
        "Unix epoch start time in seconds. If omitted, defaults to from_hours_ago hours before now."
      ),
    to_time: z
      .number()
      .int()
      .optional()
      .describe("Unix epoch end time in seconds. Defaults to now."),
    from_hours_ago: z
      .number()
      .int()
      .min(1)
      .max(8760)
      .default(24)
      .describe(
        "How many hours back to look when from_time is not provided (default: 24, max: 8760 = 1 year)"
      ),
    priority: z
      .enum(["normal", "low"])
      .optional()
      .describe('Filter by event priority: "normal" or "low" (optional)'),
    tags: z
      .string()
      .optional()
      .describe(
        'Comma-separated tags to filter events by, e.g. "env:prod,service:api" (optional)'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum number of events to return (1–1000, default: ${DEFAULT_LIMIT})`),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        'Output format: "markdown" for human-readable (default) or "json" for structured data'
      ),
  })
  .strict();

type ListEventsInput = z.infer<typeof ListEventsInputSchema>;

// ---------------------------------------------------------------------------
// Datadog API response shape (v1 events)
// ---------------------------------------------------------------------------

interface DDEvent {
  id?: number;
  title?: string;
  text?: string;
  priority?: string;
  alert_type?: string;
  date_happened?: number;
  host?: string;
  tags?: string[];
  url?: string;
}

interface DDEventsResponse {
  events?: DDEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventsMarkdown(result: EventsResult): string {
  const lines: string[] = [
    "# Datadog Events",
    "",
    `Showing **${result.count}** event${result.count === 1 ? "" : "s"}.`,
    "",
  ];

  for (const e of result.events) {
    const ts = e.date_happened
      ? new Date(e.date_happened * 1000).toISOString()
      : "unknown time";

    const alertEmoji =
      e.alert_type === "error"
        ? "🔴"
        : e.alert_type === "warning"
        ? "🟡"
        : e.alert_type === "success"
        ? "🟢"
        : "ℹ️";

    lines.push(`## ${alertEmoji} ${e.title ?? "Untitled"} (ID: ${e.id ?? "?"})`);
    lines.push(`- **Time**: ${ts}`);
    if (e.alert_type) lines.push(`- **Alert type**: ${e.alert_type}`);
    if (e.priority) lines.push(`- **Priority**: ${e.priority}`);
    if (e.host) lines.push(`- **Host**: \`${e.host}\``);
    if (e.text) lines.push(`- **Details**: ${e.text}`);
    if (e.tags && e.tags.length > 0) lines.push(`- **Tags**: ${e.tags.join(", ")}`);
    if (e.url) lines.push(`- **URL**: ${e.url}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerListEvents(server: McpServer): void {
  server.registerTool(
    "datadog_list_events",
    {
      title: "List Datadog Events",
      description: `List Datadog events and alerts from the event stream, with optional time range and tag filters.

This tool queries the Datadog Events v1 API. It does NOT write or delete any data.

Args:
  - from_time (number): Unix epoch start time in seconds (optional, overrides from_hours_ago)
  - to_time (number): Unix epoch end time in seconds (optional, defaults to now)
  - from_hours_ago (number): Hours back to look when from_time is not set (1–8760, default: 24)
  - priority (string): Filter by priority — "normal" or "low" (optional)
  - tags (string): Comma-separated tags to filter by, e.g. "env:prod" (optional)
  - limit (number): Max events to return (1–1000, default: 50)
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns (JSON format):
{
  "count": number,             // Number of events returned
  "events": [
    {
      "id": number,            // Event ID
      "title": string,         // Event title
      "text": string,          // Event body (truncated to 300 chars)
      "priority": string,      // "normal" or "low"
      "alert_type": string,    // e.g. "error", "warning", "success", "info"
      "date_happened": number, // Unix timestamp of when the event occurred
      "host": string,          // Associated host
      "tags": string[],        // Associated tags
      "url": string            // Link to the event in Datadog
    }
  ]
}

Examples:
  - "Show all alerts from the last 24 hours" → (default parameters)
  - "Show only normal priority events" → priority="normal"
  - "Events for production environment" → tags="env:prod"
  - "Errors in the last 6 hours" → from_hours_ago=6

Error handling:
  - Returns "Error: Authentication failed" if credentials are invalid
  - Returns "No events found" if no events match the time range and filters`,

      inputSchema: ListEventsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListEventsInput) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const toTime = params.to_time ?? now;
        const fromTime = params.from_time ?? now - params.from_hours_ago * 3600;

        const queryParams: Record<string, unknown> = {
          start: fromTime,
          end: toTime,
          page: 0,
        };
        if (params.priority) queryParams["priority"] = params.priority;
        if (params.tags) queryParams["tags"] = params.tags;

        const raw = await ddGet<DDEventsResponse>("/api/v1/events", queryParams);
        const events = raw.events ?? [];

        if (events.length === 0) {
          return {
            content: [
              { type: "text", text: "No events found in the given time range." },
            ],
          };
        }

        const limited = events.slice(0, params.limit);
        const entries: EventEntry[] = limited.map((e) => ({
          id: e.id ?? null,
          title: e.title ?? null,
          text: e.text ? e.text.slice(0, 300) : null,
          priority: e.priority ?? null,
          alert_type: e.alert_type ?? null,
          date_happened: e.date_happened ?? null,
          host: e.host ?? null,
          tags: e.tags ?? [],
          url: e.url ?? null,
        }));

        const result: EventsResult = {
          count: entries.length,
          events: entries,
        };

        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          text = formatEventsMarkdown(result);
        } else {
          text = JSON.stringify(result, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          const truncated = {
            ...result,
            events: result.events.slice(0, Math.max(1, Math.floor(result.events.length / 2))),
            truncated: true,
            truncation_message:
              "Response truncated. Use a smaller limit or narrow the time range.",
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
