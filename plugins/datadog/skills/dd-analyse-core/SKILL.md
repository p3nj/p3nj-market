---
name: dd-analyse-core
description: >
  Core Datadog log analysis patterns shared across ALL Prismatic integration types
  (SAP, AMT, Maximo, generic). Reads accumulated summaries from the streaming fetch
  pipeline and builds the final analysis object. Called internally by
  datadog-log-analysis — not triggered directly. Use this skill whenever processing
  Prismatic log data from accumulated summaries, regardless of integration type.
---

## Core Log Analysis — Build Analysis from Accumulated Summaries

This skill reads the summary data produced by `dd-fetch`'s streaming accumulator
and builds the structured analysis object used by downstream skills.

> **Input:**
>   - `/tmp/dd-analysis/summary.json` (accumulated counters from Phase 1 + Phase 2)
>   - `/tmp/dd-analysis/volume_counts.json` (aggregate status breakdown)
>   - `/tmp/dd-analysis/monitors.json` (optional)
>   - `/tmp/dd-analysis/events.json` (optional)
> **Output:** `/tmp/dd-analysis/analysis.json`

---

### Step 1 — Load and Validate Inputs

```python
import json, os

# Load accumulated summary
with open('/tmp/dd-analysis/summary.json') as f:
    summary = json.load(f)

# Load volume counts
volume = {}
vol_path = '/tmp/dd-analysis/volume_counts.json'
if os.path.exists(vol_path):
    with open(vol_path) as f:
        vol_data = json.load(f)
    # Extract buckets from aggregate response
    volume = vol_data.get('buckets', vol_data)

# Load optional monitors
monitors = []
mon_path = '/tmp/dd-analysis/monitors.json'
if os.path.exists(mon_path):
    with open(mon_path) as f:
        monitors = json.load(f)

# Load optional events
events = []
evt_path = '/tmp/dd-analysis/events.json'
if os.path.exists(evt_path):
    with open(evt_path) as f:
        events = json.load(f)
```

---

### Step 2 — Build Health Snapshot

Only 4 log levels exist: error, warn, info, debug.

```python
breakdown = {
    'error': volume.get('error', 0),
    'warn':  volume.get('warn', 0),
    'info':  volume.get('info', 0),
    'debug': volume.get('debug', 0),
}
total_logs = sum(breakdown.values())
issue_count = breakdown['error'] + breakdown['warn']
error_rate = f"{(issue_count / total_logs * 100):.1f}%" if total_logs > 0 else "0%"
```

---

### Step 3 — Build Top Issues from Accumulated Categories

The summary already contains categorised counts with sample messages. Sort by count
descending and take the top 10.

Entity errors (`OBZ-Entity`, `OBZ-LogEntityError`) were already excluded from
independent counting by the accumulator. They are tracked via `entity_error_exec_ids`
for cross-referencing with parent errors if needed.

```python
# Sort categories by count descending
sorted_cats = sorted(
    summary['categories'].items(),
    key=lambda x: x[1]['count'],
    reverse=True
)

top_issues = []
for category, data in sorted_cats[:10]:
    top_issues.append({
        'category': category,
        'count': data['count'],
        'severity': data['severity'],
        'samples': data['samples'],
    })
```

---

### Step 4 — Assemble the Analysis Object

```python
analysis = {
    "client_code":      CLIENT_CODE,
    "integration_type": INTEGRATION_TYPE,
    "instance_id":      instance_id or None,
    "time_window": {
        "from":     from_aest,      # e.g. "14:00 AEST"
        "to":       to_aest,        # e.g. "15:00 AEST"
        "duration": duration_str,   # e.g. "1h", "3d"
        "date":     date_str        # e.g. "28 Mar 2026"
    },
    "health_snapshot": {
        "total_logs":  total_logs,
        "breakdown":   breakdown,   # { error: N, warn: N, info: N, debug: N }
        "error_rate":  error_rate
    },
    "fetch_stats": {
        "phase1_logs": summary['phase1_count'],
        "phase2_logs": summary['phase2_count'],
        "pages_fetched": summary['pages_fetched'],
        "total_processed": summary['total_processed'],
    },
    "top_issues": top_issues,
    "work_orders": summary.get('work_orders', []),
    "affected_steps": summary.get('affected_steps', []),
    "affected_flows": summary.get('affected_flows', []),
    "monitors": monitors if monitors else None,
    "events": events if events else None,
    "interpretation": "",   # Filled in Step 5
    "caveats": []
}

# Add caveats
if not instance_id:
    analysis['caveats'].append("instanceId not resolved — using CLIENT_CODE fallback")
if summary.get('pages_fetched', 0) > 50:
    analysis['caveats'].append(f"Large dataset: {summary['pages_fetched']} pages fetched")
```

---

### Step 5 — Write Analyst Interpretation

After assembling the analysis, write a concise 2–4 sentence plain-English summary.
Think like a support engineer — not a log parser.

Guidelines:
- For yes/no questions, answer directly first
- Mention the highest-count issues and whether they're transient (retries that succeed)
  or persistent (final failures)
- Note any SAP-specific patterns if INTEGRATION_TYPE = SAP
- Flag anything unusual (sudden spikes, new error types, etc.)

Update the interpretation field, then write to disk:

```python
analysis['interpretation'] = "<your 2-4 sentence summary>"

with open('/tmp/dd-analysis/analysis.json', 'w') as f:
    json.dump(analysis, f, indent=2)
```

---

### Handoff

- **If INTEGRATION_TYPE = SAP:** → Read `dd-analyse-sap/SKILL.md` next.
  It will extend the analysis object with SAP-specific fields.
- **Otherwise:** → Skip SAP analysis. Proceed directly to `dd-report/SKILL.md`.
