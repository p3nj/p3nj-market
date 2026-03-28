---
name: dd-fetch
description: >
  Shared Datadog fetching skill for Prismatic log analysis. Handles MCP tool calls,
  cursor-based pagination, the streaming accumulator pattern, and temp file management.
  This skill is called internally by datadog-log-analysis and should not be triggered
  directly. Use when you need to fetch logs, monitors, events, or metrics from Datadog
  and store them safely for downstream processing.
---

## Datadog Fetch — Streaming Accumulator Pipeline

This skill is called by the orchestrator (`datadog-log-analysis`). It fetches logs
from Datadog using cursor-based pagination and processes each batch through a Python
accumulator script that extracts summary counters and discards raw data.

This design handles **millions of logs** over multi-day ranges without exhausting
memory or token context. Only the running summary (~few KB) persists — not raw logs.

---

### Available MCP Tools

| Tool | Purpose |
|---|---|
| `datadog_query_logs` | Search logs with full attributes. Supports cursor pagination via `cursor` + `next_cursor`. Max 1000 per page. |
| `datadog_aggregate_logs` | Count logs grouped by any facet. Fast volume counts without fetching individual logs. |
| `datadog_list_log_facets` | Sample logs to discover attributes. |

**Parameter rules:**
- Always pass `response_format: "json"`
- Use `limit: 900` per page (leaves headroom below the 80K char response limit)
- Pass `cursor: "<next_cursor>"` from previous response to get next page
- Use `sort: "timestamp"` (oldest first) for consistent pagination

---

### Setup — Run at Start of Every Analysis

```bash
rm -rf /tmp/dd-analysis && mkdir -p /tmp/dd-analysis
```

Then copy the accumulator script into place:
```bash
cp <plugin_path>/skills/dd-fetch/scripts/accumulator.py /tmp/dd-analysis/accumulator.py
```

If the accumulator script is not available at the plugin path, write it from the
bundled reference in `scripts/accumulator.py`. The script handles all categorisation
logic (core + SAP patterns) and maintains running counters in `/tmp/dd-analysis/summary.json`.

---

### Phase 1 — Fetch Error + Warn Logs

These are the highest-signal logs. Fetch ALL of them with cursor pagination.

**Query:** `<INSTANCE_FILTER> status:(error OR warn)`

**Pagination loop:**

```
1. Call datadog_query_logs:
     query:            "<INSTANCE_FILTER> status:(error OR warn)"
     from_time:        <resolved>
     to_time:          <resolved>
     limit:            900
     sort:             "timestamp"
     response_format:  "json"
     cursor:           <null for first call, next_cursor for subsequent>

2. Write the raw JSON response to /tmp/dd-analysis/batch.json

3. Run the accumulator:
     python3 /tmp/dd-analysis/accumulator.py /tmp/dd-analysis/batch.json --phase 1

   The accumulator:
   - Parses each log entry
   - Categorises by error type (retry loops, HTTP errors, SAP issues, etc.)
   - Updates running counters in /tmp/dd-analysis/summary.json
   - Extracts work orders, affected steps, sample messages
   - Deletes the batch file

4. Check the response: if has_more is true, extract next_cursor and go to step 1
   If has_more is false, Phase 1 is complete.
```

**Checkpoint:** After Phase 1, verify `/tmp/dd-analysis/summary.json` exists and
has `phase1_count > 0`. Log the count for visibility.

---

### Phase 2 — Fetch Info + Debug Logs with Error-Context Tags

Most info/debug logs are noise. Only fetch those whose message contains known
error-related tags from the Log Tag Prefix Reference.

**Query construction — build the tag filter from known tags:**

Core tags (always included):
```
FLOW OR Http-Error OR OBZ-ErrorHandler OR OBZ-Entity OR OBZ-LogEntityError OR INVOKE_ERROR OR DATA-Map OR Validation
```

SAP tags (include only if INTEGRATION_TYPE = SAP):
```
OR SAP-WARN OR SAP-Error OR SAP-DATA OR SAP-Filter
```

**Full query (SAP example):**
```
<INSTANCE_FILTER> status:(info OR debug) (FLOW OR Http-Error OR OBZ-ErrorHandler OR OBZ-Entity OR OBZ-LogEntityError OR INVOKE_ERROR OR DATA-Map OR Validation OR SAP-WARN OR SAP-Error OR SAP-DATA OR SAP-Filter)
```

**Full query (non-SAP):**
```
<INSTANCE_FILTER> status:(info OR debug) (FLOW OR Http-Error OR OBZ-ErrorHandler OR OBZ-Entity OR OBZ-LogEntityError OR INVOKE_ERROR OR DATA-Map OR Validation)
```

**Pagination loop:** Same as Phase 1, but pass `--phase 2` to the accumulator:
```
python3 /tmp/dd-analysis/accumulator.py /tmp/dd-analysis/batch.json --phase 2
```

Continue until `has_more` is false.

---

### Volume Counts — Health Snapshot

Use `datadog_aggregate_logs` for fast total counts without fetching individual logs:

```
Tool:             datadog_aggregate_logs
query:            "<INSTANCE_FILTER>"
from_time:        <resolved>
to_time:          <resolved>
group_by:         "status"
response_format:  "json"
```

This returns a breakdown like `{"error": 150, "warn": 320, "info": 50000, "debug": 120000}`.
Write to `/tmp/dd-analysis/volume_counts.json`:

```bash
cat <<'EOF' > /tmp/dd-analysis/volume_counts.json
<paste the response JSON>
EOF
```

---

### Optional: Monitors (if user asks or for extra context)

If a `mcp__datadog__datadog_list_monitors` tool is available (from the Datadog connector):

```
Tool:             mcp__datadog__datadog_list_monitors
name_filter:      "<CLIENT_CODE>"
monitor_status:   "Alert"
response_format:  "json"
```

Write to `/tmp/dd-analysis/monitors.json`.

---

### Optional: Events

If `mcp__datadog__datadog_list_events` is available:

```
Tool:             mcp__datadog__datadog_list_events
tags:             "service:Prismatic"
from_hours_ago:   <match time range>
response_format:  "json"
```

Write to `/tmp/dd-analysis/events.json`.

---

### Verification

After all phases complete, verify the pipeline produced results:

```bash
echo "=== Fetch Summary ==="
if [ -f /tmp/dd-analysis/summary.json ]; then
  python3 -c "
import json
with open('/tmp/dd-analysis/summary.json') as f:
    s = json.load(f)
print(f'Total processed: {s[\"total_processed\"]}')
print(f'Phase 1 (error+warn): {s[\"phase1_count\"]}')
print(f'Phase 2 (info+debug): {s[\"phase2_count\"]}')
print(f'Pages fetched: {s[\"pages_fetched\"]}')
print(f'Categories found: {len(s[\"categories\"])}')
print(f'Work orders: {len(s[\"work_orders\"])}')
"
else
  echo "ERROR: summary.json not found!"
fi

if [ -f /tmp/dd-analysis/volume_counts.json ]; then
  echo "Volume counts: $(cat /tmp/dd-analysis/volume_counts.json)"
fi
```

Once verified, hand off to `dd-analyse-core`.
