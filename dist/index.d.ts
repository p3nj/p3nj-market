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
export {};
//# sourceMappingURL=index.d.ts.map