---
name: dd-analyse-sap
description: >
  SAP-specific Datadog log analysis for Prismatic integrations. Extends the core
  analysis object with SAP error categorisation, HTTP codes, record locks, work order
  extraction, and SAP connector tag parsing. Called internally by datadog-log-analysis
  ONLY when the integration type is SAP — never triggered directly and never run for
  AMT, Maximo, or generic clients.
metadata:
  version: "12.0.0"
---

## SAP Log Analysis — SAP-Specific Extensions

This skill extends `dd-analyse-core`'s analysis with SAP-specific grouping and
context. It runs **only** when `INTEGRATION_TYPE = SAP`.

> **Input:** `/tmp/dd-analysis/analysis.json` (from dd-analyse-core)
>            `/tmp/dd-analysis/summary.json` (accumulated counters — SAP categories already extracted)
> **Output:** Updated `/tmp/dd-analysis/analysis.json` with `sap_integration` field

---

### SAP Log Tag Prefixes

These tags are specific to SAP integrations and supplement the core tag reference:

| Tag | Source | Level | What it means |
|---|---|---|---|
| `SAP-WARN` | SAP Connector `errorHandling.ts` | Warning | SAP returned error messages (code "E") |
| `SAP-Error` | SAP Connector `errorHandling.ts` | Debug/Warning | Failed to extract SAP messages, or failed to log error to entity |
| `SAP-DATA` | SAP Connector `sapUtilities.ts` | Debug | Raw SAP response data |
| `SAP-Filter` | SAP Connector `utilities.ts` | Debug | SAP OData filter string |

---

### How SAP Categorisation Works

The streaming accumulator (`accumulator.py`) already categorises SAP issues during
the fetch phase. SAP-related categories in `summary.json` follow these patterns:

| Category pattern | What it means |
|---|---|
| `SAP HTTP <NNN>` | SAP returned an HTTP error with status code NNN |
| `SAP ERROR · <detail>` | SAP-ERROR or SAP-FATAL with first 60 chars of message |
| `SAP <NNN> · Record lock` | SAP error NNN where "already being processed" in message |
| `SAP <NNN> · Invalid time range` | SAP error NNN with start/finish time mismatch |
| `SAP <NNN> · Future date` | SAP error NNN with future actual date |
| `SAP <NNN> · <detail>` | Other SAP returned error with code NNN |
| `SAP-WARN (other)` | SAP warning that didn't match specific patterns |
| `Integration · <detail>` | Integration error or connector failure |

---

### Step 1 — Extract SAP Categories from Summary

```python
import json

with open('/tmp/dd-analysis/summary.json') as f:
    summary = json.load(f)

with open('/tmp/dd-analysis/analysis.json') as f:
    analysis = json.load(f)

# Filter SAP-related categories from the accumulated summary
sap_categories = {}
sap_total = 0

for category, data in summary.get('categories', {}).items():
    is_sap = (
        category.startswith('SAP ') or
        category.startswith('SAP-') or
        category.startswith('Integration ·')
    )
    if is_sap:
        sap_categories[category] = data
        sap_total += data['count']

# Sort by count descending
sorted_sap = sorted(sap_categories.items(), key=lambda x: x[1]['count'], reverse=True)
```

---

### Step 2 — Extend the Analysis Object

Add the `sap_integration` field with SAP-specific detail. Do NOT re-merge into
`top_issues` — dd-analyse-core already built top_issues from ALL categories
(including SAP ones) in the accumulated summary. Re-adding would double-count.

```python
analysis['sap_integration'] = {
    "total": sap_total,
    "categories": [
        {
            "label": cat,
            "count": data['count'],
            "severity": data.get('severity', 'warn'),
            "samples": data.get('samples', [])
        }
        for cat, data in sorted_sap
    ],
    "work_orders": summary.get('work_orders', []),
    "affected_steps": summary.get('affected_steps', []),
    "affected_flows": summary.get('affected_flows', []),
}

# Write updated analysis
with open('/tmp/dd-analysis/analysis.json', 'w') as f:
    json.dump(analysis, f, indent=2)
```

---

### Handoff

SAP analysis complete. → Proceed to `dd-report/SKILL.md` to format and deliver.
