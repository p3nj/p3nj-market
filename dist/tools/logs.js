import { z } from "zod";
import { ddPost, handleApiError } from "../services/datadog.js";
import { CHARACTER_LIMIT, DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import { ResponseFormat } from "../types.js";
// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
const QueryLogsInputSchema = z
    .object({
    query: z
        .string()
        .min(1)
        .describe('Datadog log search query. Supports Datadog query syntax, e.g. "service:api status:error", "env:prod @http.status_code:5*"'),
    from_time: z
        .string()
        .default("now-1h")
        .describe('Start of the time range. Relative values like "now-1h", "now-24h" or ISO-8601 timestamps are accepted (default: "now-1h")'),
    to_time: z
        .string()
        .default("now")
        .describe('End of the time range (default: "now")'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`Maximum number of log entries to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT})`),
    cursor: z
        .string()
        .optional()
        .describe("Pagination cursor returned by a previous call. Pass this to retrieve the next page of results."),
    response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe('Output format: "markdown" for human-readable (default) or "json" for structured data'),
})
    .strict();
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatLogsMarkdown(result, query) {
    const lines = [
        `# Datadog Logs: \`${query}\``,
        "",
        `Showing **${result.count}** log entr${result.count === 1 ? "y" : "ies"}${result.has_more ? " (more available — use cursor for next page)" : ""}.`,
        "",
    ];
    for (const entry of result.logs) {
        const ts = entry.timestamp ?? "unknown time";
        const svc = entry.service ? `\`${entry.service}\`` : "—";
        const host = entry.host ? `\`${entry.host}\`` : "—";
        const status = entry.status ? `\`${entry.status}\`` : "—";
        lines.push(`## ${ts}`);
        lines.push(`- **Service**: ${svc}  **Host**: ${host}  **Status**: ${status}`);
        // Prismatic execution context
        if (entry.severity)
            lines.push(`- **Severity**: ${entry.severity}${entry.severityNumber != null ? ` (${entry.severityNumber})` : ""}`);
        if (entry.logType)
            lines.push(`- **Log Type**: ${entry.logType}`);
        if (entry.integration)
            lines.push(`- **Integration**: ${entry.integration}`);
        if (entry.instance)
            lines.push(`- **Instance**: ${entry.instance}`);
        if (entry.flow)
            lines.push(`- **Flow**: ${entry.flow}`);
        if (entry.succeeded != null) {
            const icon = entry.succeeded ? "✅" : "❌";
            lines.push(`- **Succeeded**: ${icon} ${entry.succeeded}`);
        }
        if (entry.duration != null)
            lines.push(`- **Duration**: ${entry.duration}ms`);
        if (entry.retryAttempt != null && entry.retryAttempt > 0)
            lines.push(`- **Retry Attempt**: ${entry.retryAttempt}`);
        if (entry.isTestExecution)
            lines.push(`- **Test Execution**: yes`);
        // IDs (collapsed for readability)
        const ids = [];
        if (entry.executionId)
            ids.push(`exec=\`${entry.executionId}\``);
        if (entry.instanceId)
            ids.push(`instance=\`${entry.instanceId}\``);
        if (entry.integrationId)
            ids.push(`integration=\`${entry.integrationId}\``);
        if (entry.flowId)
            ids.push(`flow=\`${entry.flowId}\``);
        if (entry.flowConfigId)
            ids.push(`flowConfig=\`${entry.flowConfigId}\``);
        if (ids.length > 0)
            lines.push(`- **IDs**: ${ids.join(", ")}`);
        if (entry.message) {
            lines.push(`- **Message**: ${entry.message}`);
        }
        if (entry.tags.length > 0) {
            lines.push(`- **Tags**: ${entry.tags.join(", ")}`);
        }
        lines.push("");
    }
    if (result.has_more && result.next_cursor) {
        lines.push(`> **Next cursor**: \`${result.next_cursor}\``);
    }
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
export function registerQueryLogs(server) {
    server.registerTool("datadog_query_logs", {
        title: "Query Datadog Logs",
        description: `Search Datadog logs using Datadog query syntax and return matching log entries.

This tool queries the Datadog Logs v2 API. It does NOT write or delete any data.

Args:
  - query (string): Datadog log search query, e.g. "service:api status:error"
  - from_time (string): Start of time range — relative ("now-1h") or ISO-8601 (default: "now-1h")
  - to_time (string): End of time range — relative or ISO-8601 (default: "now")
  - limit (number): Max log entries to return, 1–1000 (default: 50)
  - cursor (string): Pagination cursor from a previous response (optional)
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns (JSON format):
{
  "count": number,              // Number of entries in this response
  "has_more": boolean,          // Whether more results are available
  "next_cursor": string,        // Pagination cursor (present when has_more is true)
  "logs": [
    {
      "timestamp": string,      // ISO-8601 timestamp
      "service": string,        // Service name
      "status": string,         // Log level / status (e.g. "error", "warn")
      "host": string,           // Host name
      "message": string,        // Log message body
      "tags": string[],         // Associated tags

      // Prismatic execution fields (null when not present):
      "severity": string,       // e.g. "info", "error", "warn"
      "severityNumber": number, // Numeric severity level
      "logType": string,        // e.g. "EXECUTION"
      "instance": string,       // Full instance name
      "instanceId": string,     // Prismatic instance ID
      "integration": string,    // Integration template name
      "integrationId": string,  // Prismatic integration ID
      "flow": string,           // Flow name within the integration
      "flowId": string,         // Prismatic flow ID
      "flowConfigId": string,   // Flow config ID
      "executionId": string,    // Execution result ID
      "retryAttempt": number,   // Retry attempt number (0 = first run)
      "isTestExecution": boolean, // Whether this was a test execution
      "succeeded": boolean,     // Whether the execution succeeded
      "duration": number        // Execution duration in milliseconds
    }
  ]
}

Examples:
  - "Show errors from the API service in the last hour" → query="service:api status:error", from_time="now-1h"
  - "Find logs from host web-01 yesterday" → query="host:web-01", from_time="now-24h"
  - "Next page" → pass the cursor value from the previous response

Error handling:
  - Returns "Error: Authentication failed" if credentials are invalid
  - Returns "No logs found" if the query returns zero results`,
        inputSchema: QueryLogsInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const body = {
                filter: {
                    query: params.query,
                    from: params.from_time,
                    to: params.to_time,
                },
                sort: "-timestamp",
                page: {
                    limit: params.limit,
                    ...(params.cursor ? { cursor: params.cursor } : {}),
                },
            };
            const raw = await ddPost("/api/v2/logs/events/search", body);
            const entries = raw.data ?? [];
            if (entries.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No logs found for query: '${params.query}' between ${params.from_time} and ${params.to_time}.`,
                        },
                    ],
                };
            }
            const nextCursor = raw.meta?.page?.after;
            const logs = entries.map((e) => {
                const attrs = e.attributes ?? {};
                const inner = attrs.attributes ?? {};
                return {
                    timestamp: attrs.timestamp ?? null,
                    service: attrs.service ?? null,
                    status: attrs.status ?? null,
                    host: attrs.host ?? null,
                    message: attrs.message ?? inner.message ?? null,
                    tags: attrs.tags ?? [],
                    // Prismatic execution fields
                    severity: inner.severity ?? null,
                    severityNumber: typeof inner.severityNumber === "number" ? inner.severityNumber : null,
                    logType: inner.logType ?? null,
                    instance: inner.instance ?? null,
                    instanceId: inner.instanceId ?? null,
                    integration: inner.integration ?? null,
                    integrationId: inner.integrationId ?? null,
                    flow: inner.flow ?? null,
                    flowId: inner.flowId ?? null,
                    flowConfigId: inner.flowConfigId ?? null,
                    executionId: inner.executionId ?? null,
                    retryAttempt: typeof inner.retryAttempt === "number" ? inner.retryAttempt : null,
                    isTestExecution: typeof inner.isTestExecution === "boolean" ? inner.isTestExecution : null,
                    succeeded: typeof inner.succeeded === "boolean" ? inner.succeeded : null,
                    duration: typeof inner.duration === "number" ? inner.duration : null,
                };
            });
            const result = {
                count: logs.length,
                has_more: !!nextCursor,
                ...(nextCursor ? { next_cursor: nextCursor } : {}),
                logs,
            };
            let text;
            if (params.response_format === ResponseFormat.MARKDOWN) {
                text = formatLogsMarkdown(result, params.query);
            }
            else {
                text = JSON.stringify(result, null, 2);
            }
            if (text.length > CHARACTER_LIMIT) {
                const truncated = {
                    ...result,
                    logs: result.logs.slice(0, Math.max(1, Math.floor(result.logs.length / 2))),
                };
                text = JSON.stringify({
                    ...truncated,
                    truncated: true,
                    truncation_message: `Response truncated from ${result.logs.length} to ${truncated.logs.length} entries. Use a smaller limit or add filters.`,
                }, null, 2);
            }
            return {
                content: [{ type: "text", text }],
                structuredContent: result,
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: handleApiError(error) }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=logs.js.map