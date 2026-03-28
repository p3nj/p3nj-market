#!/usr/bin/env python3
"""
Streaming log accumulator for Datadog Prismatic analysis.

Processes one batch of logs at a time, updating running summary counters.
Designed to handle millions of logs without holding raw data in memory.

Usage:
    python3 accumulator.py <batch_file> [--phase 1|2]

The batch file is a JSON file containing the MCP tool response.
After processing, the batch file is deleted to free space.
Running summary is maintained in /tmp/dd-analysis/summary.json.
"""
import json, sys, re, os
from collections import Counter

ANALYSIS_DIR = '/tmp/dd-analysis'
SUMMARY_PATH = os.path.join(ANALYSIS_DIR, 'summary.json')
MAX_SAMPLES = 3  # Keep top N sample messages per category

# ── Log Tag Patterns ────────────────────────────────────────────────────────
# Core tags (all integration types)
CORE_TAGS = [
    'FLOW', 'Http-Error', 'OBZ-ErrorHandler', 'OBZ-Entity',
    'OBZ-LogEntityError', 'INVOKE_ERROR', 'DATA-Map', 'Validation'
]
# SAP-specific tags
SAP_TAGS = ['SAP-WARN', 'SAP-Error', 'SAP-DATA', 'SAP-Filter']

# Entity error tags — always secondary, never root cause
ENTITY_TAGS = {'OBZ-Entity', 'OBZ-LogEntityError'}


def load_or_init_summary():
    """Load existing summary or create a fresh one."""
    if os.path.exists(SUMMARY_PATH):
        with open(SUMMARY_PATH) as f:
            return json.load(f)
    return {
        'total_processed': 0,
        'phase1_count': 0,       # error + warn logs processed
        'phase2_count': 0,       # info + debug logs with error tags
        'pages_fetched': 0,
        'categories': {},        # {category: {count: N, severity: str, samples: [str]}}
        'work_orders': [],       # unique WO numbers
        'affected_steps': [],    # unique step/flow names
        'affected_flows': [],    # unique flow names
        'entity_error_exec_ids': [],  # executionIds with entity errors
        'status_counts': {'error': 0, 'warn': 0, 'info': 0, 'debug': 0},
    }


def save_summary(summary):
    """Persist the running summary to disk."""
    # Deduplicate lists
    summary['work_orders'] = sorted(set(summary['work_orders']))
    summary['affected_steps'] = sorted(set(summary['affected_steps']))
    summary['affected_flows'] = sorted(set(summary['affected_flows']))
    summary['entity_error_exec_ids'] = list(set(summary['entity_error_exec_ids']))

    with open(SUMMARY_PATH, 'w') as f:
        json.dump(summary, f, indent=2)


def add_to_category(summary, category, severity, sample_msg):
    """Increment a category counter and keep top N sample messages."""
    if category not in summary['categories']:
        summary['categories'][category] = {
            'count': 0,
            'severity': severity,
            'samples': []
        }
    cat = summary['categories'][category]
    cat['count'] += 1
    if len(cat['samples']) < MAX_SAMPLES:
        truncated = sample_msg[:200] if sample_msg else ''
        if truncated and truncated not in cat['samples']:
            cat['samples'].append(truncated)


def categorise_log(msg, status, attrs, summary):
    """Categorise a single log entry and update summary counters."""
    exec_id = attrs.get('executionId') or attrs.get('execution_id')
    flow_name = attrs.get('flow') or ''
    step_name = attrs.get('step') or ''

    # Extract work orders
    for wo in re.findall(r'Work Order (\d+)', msg):
        summary['work_orders'].append(wo)

    # Track affected steps and flows
    if step_name:
        summary['affected_steps'].append(step_name)
    if flow_name:
        summary['affected_flows'].append(flow_name)
    # Also try parsing from message
    step_match = re.search(r"Step '([^']+)'", msg)
    if step_match:
        summary['affected_steps'].append(step_match.group(1))

    # ── Entity errors (secondary — skip as independent issues) ──
    if any(tag in msg for tag in ENTITY_TAGS):
        if exec_id:
            summary['entity_error_exec_ids'].append(exec_id)
        return  # Don't count independently

    # ── SAP-specific categorisation ──
    sap_http = re.search(r'SAP HTTP error \((\d+)\)', msg)
    if sap_http:
        add_to_category(summary, f"SAP HTTP {sap_http.group(1)}", 'error', msg)
        return

    if 'SAP-ERROR' in msg or 'SAP-FATAL' in msg:
        detail = msg[:60].strip()
        add_to_category(summary, f"SAP ERROR · {detail}", 'error', msg)
        return

    sap_returned = re.search(r'SAP returned error \((\d+)\):', msg)
    if sap_returned:
        code = sap_returned.group(1)
        lower_msg = msg.lower()
        if 'already being processed' in lower_msg:
            add_to_category(summary, f"SAP {code} · Record lock", 'warn', msg)
        elif 'start' in lower_msg and 'finish' in lower_msg and 'time' in lower_msg:
            add_to_category(summary, f"SAP {code} · Invalid time range", 'warn', msg)
        elif 'future' in lower_msg and 'date' in lower_msg:
            add_to_category(summary, f"SAP {code} · Future date", 'warn', msg)
        else:
            detail = msg.split(':', 2)[-1][:60].strip() if ':' in msg else msg[:60]
            add_to_category(summary, f"SAP {code} · {detail}", 'warn', msg)
        return

    if 'SAP-WARN' in msg:
        add_to_category(summary, 'SAP-WARN (other)', 'warn', msg)
        return

    if 'Integration error' in msg or ('connector' in msg.lower() and status in ('error', 'warn')):
        detail = msg[:60].strip()
        add_to_category(summary, f"Integration · {detail}", 'error', msg)
        return

    # ── Core categorisation ──
    if 'retry' in msg.lower() and "Step '" in msg:
        add_to_category(summary, 'Retry loops (FLOW)', 'warn', msg)
    elif "Execution of '" in msg and 'failed' in msg:
        add_to_category(summary, 'Execution failures (FLOW)', 'error', msg)
    elif 'Http-Error' in msg:
        add_to_category(summary, 'Http-Error (Obzervr API)', 'error', msg)
    elif 'timeout' in msg.lower():
        add_to_category(summary, 'Timeout', 'error', msg)
    elif 'exception' in msg.lower() or 'unhandled' in msg.lower():
        add_to_category(summary, 'Unhandled exception', 'error', msg)
    elif 'INVOKE_ERROR' in msg:
        add_to_category(summary, 'Flow invocation failure (INVOKE_ERROR)', 'error', msg)
    elif 'DATA-Map' in msg:
        add_to_category(summary, 'Data mapping error (DATA-Map)', 'error', msg)
    elif 'Validation' in msg:
        add_to_category(summary, 'Validation warning', 'warn', msg)
    elif 'OBZ-ErrorHandler' in msg:
        add_to_category(summary, 'ErrorHandler (no loggers)', 'error', msg)
    else:
        # Generic — use the tag prefix if present
        tag = msg.split(']')[0].replace('[', '').strip() if ']' in msg else 'Other'
        add_to_category(summary, f"{tag} ({status})", status, msg)


def process_batch(batch_path, phase):
    """Process a single batch of logs and update the running summary."""
    summary = load_or_init_summary()

    with open(batch_path) as f:
        data = json.load(f)

    logs = data.get('logs', [])
    summary['pages_fetched'] += 1

    for entry in logs:
        msg = entry.get('message', '') or ''
        status = entry.get('status', '') or ''
        attrs = {k: v for k, v in entry.items()
                 if k not in ('id', 'timestamp', 'status', 'message', 'service', 'host', 'tags')}

        # Update status counts
        if status in summary['status_counts']:
            summary['status_counts'][status] += 1

        # Update phase counts
        if phase == 1:
            summary['phase1_count'] += 1
        else:
            summary['phase2_count'] += 1

        summary['total_processed'] += 1

        # Categorise
        categorise_log(msg, status, attrs, summary)

    save_summary(summary)

    # Delete the batch file to free space
    os.remove(batch_path)

    # Print progress for visibility
    print(f"Phase {phase} | Page {summary['pages_fetched']} | "
          f"Batch: {len(logs)} logs | Total processed: {summary['total_processed']} | "
          f"Categories: {len(summary['categories'])}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 accumulator.py <batch_file> [--phase 1|2]", file=sys.stderr)
        sys.exit(1)

    batch_file = sys.argv[1]
    phase = 1
    if '--phase' in sys.argv:
        idx = sys.argv.index('--phase')
        if idx + 1 < len(sys.argv):
            phase = int(sys.argv[idx + 1])

    process_batch(batch_file, phase)
