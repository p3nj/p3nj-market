#!/usr/bin/env node
/**
 * Datadog MCP Server
 *
 * Exposes four tools to Claude via the Model Context Protocol (stdio transport):
 *   • datadog_query_logs     – search Datadog logs (v2 API)
 *   • datadog_query_metrics  – fetch timeseries metric data (v1 API)
 *   • datadog_list_monitors  – list monitors and their current status (v1 API)
 *   • datadog_list_events    – list events / alerts from the event stream (v1 API)
 *
 * Required environment variables:
 *   DD_API_KEY   – Datadog API key
 *   DD_APP_KEY   – Datadog Application key
 *   DD_SITE      – (optional) Datadog site, e.g. "datadoghq.eu" (default: "datadoghq.com")
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerQueryLogs } from "./tools/logs.js";
import { registerQueryMetrics } from "./tools/metrics.js";
import { registerListMonitors } from "./tools/monitors.js";
import { registerListEvents } from "./tools/events.js";
// ---------------------------------------------------------------------------
// Validate credentials at startup (fail fast with a clear message)
// ---------------------------------------------------------------------------
function validateEnv() {
    const missing = [];
    if (!process.env.DD_API_KEY)
        missing.push("DD_API_KEY");
    if (!process.env.DD_APP_KEY)
        missing.push("DD_APP_KEY");
    if (missing.length > 0) {
        console.error(`ERROR: Required environment variable${missing.length > 1 ? "s" : ""} not set: ${missing.join(", ")}\n` +
            "Please configure DD_API_KEY and DD_APP_KEY in your plugin settings.");
        process.exit(1);
    }
    const site = process.env.DD_SITE ?? "datadoghq.com";
    console.error(`Datadog MCP Server starting (site: ${site})`);
}
// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
async function main() {
    validateEnv();
    const server = new McpServer({
        name: "datadog-mcp-server",
        version: "1.0.0",
    });
    // Register all tools
    registerQueryLogs(server);
    registerQueryMetrics(server);
    registerListMonitors(server);
    registerListEvents(server);
    // Connect via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Datadog MCP Server running via stdio — ready for requests.");
}
main().catch((error) => {
    console.error("Fatal server error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
});
//# sourceMappingURL=index.js.map