---
name: dd-report
description: >
  Formats and delivers Datadog Prismatic log analysis results. Takes the analysis object
  from /tmp/dd-analysis/analysis.json and outputs it to the user's requested destination:
  chat (default), Slack, Notion, email, or docx file. Called internally by
  datadog-log-analysis as the final step — not triggered directly. Also use this skill
  whenever you need to format or re-deliver a previously completed analysis, or when the
  user says "send that to Slack", "put that in Notion", "DM me the results", or
  "write that up as a report".
---

## Report — Format & Deliver Analysis

Final skill in the pipeline. Reads the completed analysis object and formats it
for the user's requested delivery channel.

> **Input:** `/tmp/dd-analysis/analysis.json` (built by dd-analyse-core, optionally extended by dd-analyse-sap)
> **Output:** Formatted report delivered to the requested channel

---

### Step 1 — Detect Delivery Intent

From the user's original message:

| User says | Delivery |
|---|---|
| "send to Slack" / "DM me" / "post to #channel" | Slack via Slack MCP |
| "put it in Notion" / "create a page" | Notion page via Notion MCP |
| "write a report" / "save as doc" | `.md` or `.docx` file |
| "email the summary" / "send via email" | Outlook via Microsoft 365 MCP |
| _(nothing specified)_ | Present in chat (default) |

---

### Step 2 — Load the Analysis Object

```python
import json
with open('/tmp/dd-analysis/analysis.json') as f:
    analysis = json.load(f)
```

---

### Step 3 — Format for Delivery Channel

#### Default Chat Format

```
**<CLIENT_CODE>** · <DD Mon> · <HH:MM – HH:MM AEST> (<duration>) · <Integration type> integration

**Health:** <total> logs — <error_rate> issues
Info <N> · Debug <N> · Warn <N> · Error <N>

**Fetch stats:** Phase 1 (error+warn): <N> · Phase 2 (info+debug): <N> · Pages: <N>

**What's happening:**
<2-4 sentence analyst interpretation>

**Top issues:**
1. <issue> — **<count>** hits
2. ...

**SAP / Integration:**
← INCLUDE THIS SECTION ONLY for SAP integrations where sap_integration exists.
← OMIT ENTIRELY for AMT, Maximo, generic, or when sap_integration is absent.
← Do NOT write "N/A" — simply leave the section out.
- <label> — <count> — WOs: ...

**Monitors:** (only if monitors is non-empty)
- <monitor name> — <status>

**Recent Events:** (only if events is non-empty)
- <event title> — <alert_type> — <date>
```

**Important formatting rules:**
- Only 4 log levels: error, warn, info, debug. Never include critical or emergency.
- SAP section: include ONLY for SAP integrations. Omit entirely for all others.
- Monitors/Events: include only if data was fetched and is non-empty.

#### Slack Format

Same structure adapted for Slack mrkdwn:
- Use `*bold*` instead of `**bold**`
- Use `:warning:` `:red_circle:` `:white_check_mark:` emojis for severity
- Keep concise and scannable
- Send via `Slack:slack_send_message` or `Slack:slack_send_message_draft`

```
*<CLIENT_CODE>* · <DD Mon> · <HH:MM – HH:MM AEST> · <Integration type>

*Health:* <total> logs — <error_rate> issues
Info <N> · Debug <N> · Warn <N> · Error <N>

*What's happening:*
<interpretation>

*Top issues:*
1. <issue> — *<count>* hits
2. ...
```

#### Notion Format

Create a Notion page with:
- Title: `<CLIENT_CODE> Log Analysis — <DD Mon YYYY>`
- Sections matching the chat format, using Notion rich text formatting
- Use `Notion:notion-create-pages` tool

#### Email Format (Outlook)

Subject: `[Datadog] <CLIENT_CODE> Log Analysis — <DD Mon>`
Body: Same structure as chat format, formatted as HTML.
Use Microsoft 365 MCP tools to send.

#### File Format (.md / .docx)

- `.md`: Write the chat format to a file
- `.docx`: Read the docx skill and produce a formatted Word document

---

### Step 4 — Deliver

Execute delivery based on detected intent. For Slack and email, ask for user
confirmation before sending.

For chat delivery, output the formatted text directly in the conversation.

---

### Re-delivery

If the user asks to re-deliver a previous analysis ("send that to Slack", "now put it
in Notion"), check if `/tmp/dd-analysis/analysis.json` still exists. If so, re-read
it and format for the new channel. No need to re-run the pipeline.

If the file doesn't exist (new session), inform the user that the analysis needs to
be re-run first.
