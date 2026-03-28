---
name: datadog-log-analysis
description: >
  Use this skill when the user asks to check, analyse, or query Datadog logs for
  a specific client instance or environment — e.g. "check RH99", "any errors in QR99
  last hour", "look at QR01 warnings", "what's happening in RH98", or any request that
  includes a client name or environment code alongside a log-related question.
  Also triggers on: "check the Datadog logs", "analyse Prismatic logs", "send me a log
  summary via Slack", "any monitors alerting", "what events happened".
  Understands natural language — the client code can be embedded anywhere in the message.
  Also use this skill when the user asks about Datadog monitors, events, or metrics
  related to Prismatic or client environments.
---

## Datadog Prismatic Log Analysis — Orchestrator

This skill orchestrates the full log analysis pipeline. It parses the user request,
resolves the client instance, then delegates to sub-skills for fetching, analysis,
and reporting.

The plugin bundles its own **Datadog MCP server** with these tools:

| Tool | Purpose |
|---|---|
| `datadog_query_logs` | Search logs with full attribute passthrough. Supports cursor-based pagination for millions of logs. |
| `datadog_aggregate_logs` | Count logs grouped by any facet (status, service, flow, step). Fast — no individual logs returned. |
| `datadog_list_log_facets` | Sample logs to discover available attributes. |

These tools use `@`-prefixed Datadog query syntax (e.g. `@service:Prismatic`).
Always pass `response_format: "json"`.

---

### Log Tag Prefix Reference

Every Prismatic log message is prefixed with a tag identifying its source. Use this
table when categorising and interpreting log entries:

| Tag | Source | Level | What it means |
|---|---|---|---|
| `FLOW` | Coded Flows (all) | Info/Error/Debug/Warning | General flow execution steps and errors |
| `Http-Error` | Common `client.ts` | Error | HTTP request failures |
| `OBZ-ErrorHandler` | Common `functions.ts` | Error | No error loggers configured / failed to log error |
| `OBZ-Entity` | Common `functions.ts` | Error | Entity error record logging failures |
| `OBZ-LogEntityError` | Common `functions.ts` | Error | Entity error logging failure |
| `INVOKE_ERROR` | Common `invokeWithErrorHandling.ts` | Error | Flow invocation failure |
| `DATA-Map` | Common `shared.ts` / `actions.ts` | Error/Debug | Data mapping/transform failures |
| `Validation` | Common `dataConverter.ts` | Warning | Data validation issues |
| `SAP-WARN` | SAP Connector `errorHandling.ts` | Warning | SAP returned error messages (code "E") |
| `SAP-Error` | SAP Connector `errorHandling.ts` | Debug/Warning | Failed to extract SAP messages |
| `SAP-DATA` | SAP Connector `sapUtilities.ts` | Debug | Raw SAP response data |
| `SAP-Filter` | SAP Connector `utilities.ts` | Debug | SAP OData filter string |

**Entity errors are always secondary:** `OBZ-Entity` and `OBZ-LogEntityError` are never
the root cause. They correspond to an earlier error in the same execution. Group them
with their parent error, never count independently.

**Only 4 log levels exist:** error, warn, info, debug. There is no critical or emergency.

---

### Pipeline Overview

```
Step 1 ──→ Step 1.5 ──→ dd-fetch ──→ dd-analyse-core ──→ dd-analyse-sap ──→ dd-report
Parse       Resolve       Fetch &       Build analysis     SAP-specific       Format &
request     instanceId    accumulate    object             extension          deliver
                          (Phase 1+2)   from summaries     (SAP only)
```

Each sub-skill reads its own SKILL.md when invoked. The orchestrator controls which
sub-skills run and in what order.

---

### Step 1 — Parse the Request

Extract from the user message:

- **CLIENT_CODE** — the instance/environment code (e.g. RH98, QR99, EM01, RH99).
  Ask with AskUserQuestion if missing.

- **Time range** — convert to `from_time` / `to_time`:
  - "last 2 hours" / "past 2h" → `from_time="now-2h"`
  - "past 30 minutes" → `from_time="now-30m"`
  - "today" → convert midnight AEST to ISO 8601 UTC (e.g. `2026-03-28T14:00:00Z` for midnight 29 Mar AEST)
  - "since Monday" → convert Monday 00:00 AEST to ISO 8601 UTC
  - "last 24 hours" → `from_time="now-24h"`
  - Default if unspecified: `from_time="now-1h"`, `to_time="now"`
  - User timezone: **Australia/Brisbane (AEST = UTC+10, no DST)**

- **Filters** (translate to Datadog query syntax):
  - Step name: search in message text, e.g. `"Time Confirmation"`
  - Flow name: search in message text, e.g. `"Assignments"`
  - Status: `status:error` or `status:(error OR warn)`
  - Free text: append to query — e.g. `Http-Error`, `timeout`

---

### Step 1.5 — Resolve instanceId and Detect Integration Type

This step is a **mandatory gate**. It must complete before any fetching begins.
It's a single quick call — not a bottleneck.

```
Tool:             datadog_query_logs
query:            "@service:Prismatic <CLIENT_CODE>"
from_time:        <resolved>
to_time:          <resolved>
limit:            10
response_format:  "json"
```

Wait for the response. Inspect each log entry:

- Extract `instanceId` from the log attributes (it's a top-level field in the
  flattened response since the MCP server preserves all nested attributes).
- Determine **INTEGRATION_TYPE** from the `instance` or `integration` attribute:
  - Contains `SAP` → **SAP**
  - Contains `AMT` → **AMT**
  - Contains `Maximo` → **Maximo**
  - Otherwise → **generic**

Record both values. Build `INSTANCE_FILTER`:
- If instanceId found: `@service:Prismatic @instanceId:<instanceId>`
- If not found (fallback): `@service:Prismatic <CLIENT_CODE>` — flag in summary

---

### Step 2 — Decide What to Fetch

Based on the user's intent:

**For general health checks** ("check RH99", "how's QR01 looking?", "give me a summary"):
1. Read `dd-fetch/SKILL.md` → run the full fetch pipeline (Phase 1 + Phase 2 + volume counts)
2. Read `dd-analyse-core/SKILL.md` → build the analysis object from accumulated summaries
3. **Only if INTEGRATION_TYPE = SAP:** read `dd-analyse-sap/SKILL.md` → extend with SAP fields
4. Read `dd-report/SKILL.md` → format and deliver

**For targeted questions** ("did QR01 have failed Time Confirmation?"):
1. Single `datadog_query_logs` call with filters built from instanceId
2. Answer the question directly — no need for the full pipeline

**For volume/distribution questions** ("how many errors vs warnings?"):
1. Use `datadog_aggregate_logs` with `group_by="status"` — fast, no individual logs
2. Answer directly

**For monitor status** ("any monitors alerting?"):
1. Use the Datadog connector's `mcp__datadog__datadog_list_monitors` if available
2. Otherwise answer based on log data

**For discovery** ("what attributes do these logs have?"):
1. Use `datadog_list_log_facets` to sample and inspect

---

### Handoff to Sub-Skills

When reading a sub-skill, pass these variables (carry them through the pipeline):

| Variable | Value |
|---|---|
| `CLIENT_CODE` | From Step 1 |
| `INSTANCE_FILTER` | From Step 1.5 |
| `INTEGRATION_TYPE` | From Step 1.5 (`SAP`, `AMT`, `Maximo`, `generic`) |
| `from_time` | Resolved time range start |
| `to_time` | Resolved time range end |
| `DELIVERY_INTENT` | Where to send results (chat, Slack, Notion, email, docx) |
