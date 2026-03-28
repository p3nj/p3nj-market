# Datadog Log Analyst Plugin (v2.0.0)

Query and analyse Datadog logs with full attribute passthrough. Designed for Prismatic
integration health checks, but the MCP server is service-agnostic.

## What's included

**MCP Server** (`servers/dd-server.mjs`):
- `datadog_query_logs` — Search logs with full attribute passthrough + cursor-based pagination
- `datadog_aggregate_logs` — Count logs grouped by any facet (fast, no individual logs)
- `datadog_list_log_facets` — Discover available attributes from a sample of logs

**Skills:**
- `datadog-log-analysis` — Orchestrator: parses requests, resolves instanceId, delegates to sub-skills
- `dd-fetch` — Streaming fetch pipeline with cursor pagination and Python accumulator for million-log datasets
- `dd-analyse-core` — Builds analysis object from accumulated summaries (all integration types)
- `dd-analyse-sap` — SAP-specific error categorisation (SAP integrations only)
- `dd-report` — Formats and delivers results to chat, Slack, Notion, email, or docx

## Configuration

Set these environment variables:
- `DD_API_KEY` — Datadog API key
- `DD_APP_KEY` — Datadog Application key
- `DD_SITE` — Datadog site (default: `datadoghq.com`)

## Architecture

The plugin uses a **streaming accumulator** pattern to handle multi-day log ranges
(millions of entries) without exhausting memory or token context:

1. Cursor-paginated fetches (900 logs per page)
2. Each batch processed by `accumulator.py` → extracts categories, counts, samples
3. Raw batch discarded, only running summary (~KB) persists
4. Analysis built from accumulated summaries, not raw logs

## Log levels

Only 4 log levels exist in the environment: error, warn, info, debug.

## Query syntax

All queries use Datadog's `@`-prefixed syntax: `@service:Prismatic @instanceId:<id>`
