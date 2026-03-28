---
name: mcp-connector-builder
description: >
  Complete guide for building and distributing custom MCP (Model Context Protocol) connectors as
  Claude Desktop Extension bundles (.mcpb files). Use this skill whenever a user wants to:
  create a custom MCP server, package an MCP for Claude Desktop, build a connector for an API
  or internal tool, distribute an MCP to their team or company, create or fix a manifest.json
  for a Claude extension, package a .mcpb or .dxt file, set up user_config for API keys, or
  publish a connector. Also triggers for: "how do I build a Claude connector", "how do I share
  my MCP with my team", "how do I package my MCP server", or any variation of creating
  distributable Claude Desktop extensions. ALWAYS use this skill when building or packaging MCPs —
  it contains the correct spec version, CLI commands, and distribution steps.
metadata:
  version: "1.0.0"
---

# MCP Connector Builder

This skill guides you through the full workflow: write an MCP server → package it as a Claude Desktop Extension bundle (`.mcpb`) → distribute to your team.

**Key terminology:**
- **MCPB** (MCP Bundle) — the current format name. File extension: `.mcpb`. Formerly called DXT (`.dxt`). Both extensions install in Claude Desktop, but `.mcpb` + `manifest_version: "0.3"` is the current standard.
- **Claude Desktop Extension** — a self-contained bundle users install by double-clicking. No terminal required on their end.

---

## Step 1: Scaffold the project

**Use Node.js.** It ships with Claude Desktop so end users need zero additional setup. Python requires them to have Python installed — adds friction.

```
my-connector/
├── manifest.json          ← Required. Bundle metadata & config.
├── package.json
├── icon.png               ← 512×512px PNG recommended (256×256 minimum)
└── servers/
    └── server.mjs         ← MCP server entry point
```

```bash
mkdir my-connector && cd my-connector
npm init -y
npm install @modelcontextprotocol/sdk zod
```

In `package.json`, set `"type": "module"` so ES module imports work.

---

## Step 2: Write the MCP server

Use `McpServer` + `registerTool` (the modern API). Validate all inputs with Zod `.strict()`.

```js
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Read credentials from env (injected by manifest at runtime)
const API_KEY = process.env.MY_API_KEY || '';

// Validate required credentials at startup
if (!API_KEY) {
  console.error('ERROR: MY_API_KEY is required. Configure it in connector settings.');
  process.exit(1);
}

const server = new McpServer({ name: 'my-connector', version: '1.0.0' });

server.registerTool('tool_name', {
  title: 'Human-readable title',
  description: `What this tool does and when Claude should use it.
Include examples of good inputs so Claude uses it correctly.`,
  inputSchema: z.object({
    query: z.string().describe('What to search for. Example: "error logs from last hour"'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
  }).strict(),
  annotations: {
    readOnlyHint: true,       // true = no side effects (reads only)
    destructiveHint: false,   // false = won't delete/modify data
    idempotentHint: true,     // true = safe to retry
    openWorldHint: true,      // true = calls external APIs
  },
}, async (params) => {
  try {
    const result = await callYourApi(params.query, params.limit);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,   // tells Claude to surface this as an error
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Good tool design:**
- One tool, one responsibility. Don't cram multiple operations into one tool.
- Write descriptions that explain *when* Claude should call this tool, not just what it does.
- Return structured JSON for complex data. Return markdown for human-readable summaries.
- Truncate large responses (e.g. cap at 80,000 chars) to avoid overflowing Claude's context.

---

## Step 3: Write manifest.json (spec 0.3)

This is the most critical file. **Use `manifest_version: "0.3"`** — not `dxt_version`.

```json
{
  "manifest_version": "0.3",
  "name": "my-connector",
  "display_name": "My Connector",
  "version": "1.0.0",
  "description": "One-line description shown in Claude Desktop.",
  "long_description": "Detailed description in markdown. Explain what APIs this connects to and what problems it solves.",
  "author": {
    "name": "Your Name",
    "url": "https://yoursite.com"
  },
  "icon": "icon.png",
  "homepage": "https://yoursite.com",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does."
    }
  ],
  "server": {
    "type": "node",
    "entry_point": "servers/server.mjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/servers/server.mjs"],
      "env": {
        "MY_API_KEY": "${user_config.api_key}",
        "MY_SITE":    "${user_config.site}"
      }
    }
  },
  "user_config": {
    "api_key": {
      "type": "string",
      "title": "API Key",
      "description": "Your API key. Found at Organization Settings → API Keys.",
      "sensitive": true,
      "required": true
    },
    "site": {
      "type": "string",
      "title": "Site",
      "description": "Your site URL, e.g. app.example.com",
      "sensitive": false,
      "required": false,
      "default": "app.example.com"
    }
  },
  "compatibility": {
    "runtimes": { "node": ">=18" }
  }
}
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `manifest_version` | Yes | Must be `"0.3"` |
| `name` | Yes | Machine-readable, no spaces |
| `display_name` | No | Human-friendly name for the UI |
| `version` | Yes | Semver, e.g. `"1.0.0"` |
| `description` | Yes | Shown in Claude Desktop UI |
| `author.name` | Yes | — |
| `server` | Yes | Runtime config (see below) |
| `tools` | Recommended | Declare all tools statically. Required for directory submission. |
| `user_config` | Recommended | Declare all user-supplied values (API keys, sites, etc.) |

**`server.type` options:** `"node"` (recommended), `"python"`, `"binary"`, `"uv"` (experimental)

**Template variables in `args` / `env`:**
- `${__dirname}` — extension install directory
- `${user_config.FIELD}` — value the user typed in settings
- `${HOME}`, `${USER}` — system environment variables

**`user_config` field types:** `string`, `number`, `boolean`, `directory`, `file`, `enum`
- `sensitive: true` → stored in OS keychain, masked in UI (use for API keys/passwords)
- `required: true` → extension won't enable until the user fills this in
- `default` → pre-fills the field in settings UI

---

## Step 4: Install CLI and package

```bash
# Install the mcpb CLI (one-time global install)
npm install -g @anthropic-ai/mcpb

# Always validate first — catches spec errors before packaging
mcpb validate manifest.json

# Package into a .mcpb bundle
mcpb pack
```

Output file: `<name>-<version>.mcpb`

The bundle is a zip of your project files + `node_modules` (production deps). Dev dependencies and files matching `.mcpbignore` / `.npmignore` are excluded automatically.

> **Important:** `mcpb` v2.1.2+ is required for `manifest_version: "0.3"`. The older `dxt` CLI (v0.2.6) only supports the old `dxt_version` key and will reject the current spec. Always use `mcpb`.

---

## Step 5: Test locally

1. Double-click the `.mcpb` file, **or**
2. In Claude Desktop: **Settings → Extensions → Install Extension** → select the file
3. Fill in your `user_config` fields when prompted
4. Start a conversation and test your tools

Check Claude Desktop logs if something doesn't work:
- macOS: `~/Library/Logs/Claude/`

---

## Step 6: Distribute to your team

### Option A — Direct file sharing (simplest)
Share the `.mcpb` file via Slack, email, or shared drive. Team members double-click to install. Each person installs individually on their own machine.

### Option B — Enterprise Allowlist (recommended for teams)
Available on Team and Enterprise plans.

1. Go to **Organization Settings → Connectors → Desktop tab**
2. Toggle on **Allowlist**
3. Click **Add Extension** → upload your `.mcpb` as a private/custom extension
4. It's now visible only to your org — team members install from Claude Desktop's connector settings

> **Warning:** Enabling the allowlist removes all previously-installed extensions from team members' Claude Desktop. Give everyone a heads-up before enabling.

### Option C — MDM / Group Policy (large enterprise)
macOS MDM profiles and Windows Group Policy can pre-install approved extensions automatically. Requires Claude Desktop v0.13.91+.

### Updating a published connector
Increment `version` in both `manifest.json` and `package.json`, repack, and redistribute. For Option B (allowlist), upload the new `.mcpb` and existing users can update from their connector settings.

---

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `dxt_version: Required` + `manifest_version: Unrecognized` | Old `dxt` CLI | `npm install -g @anthropic-ai/mcpb` |
| Server starts but tools aren't available | Wrong transport | Use `StdioServerTransport`, not HTTP |
| Tools fail silently | Env vars not injected | Check `user_config` → `env` mappings in manifest |
| Bundle is very large (>20 MB) | Dev deps or test files included | Add `.mcpbignore`, run `npm install --production` before packing |
| Credentials not saved between restarts | Hardcoded in server file | Read from `process.env` — manifest injects them at startup |
| `mcpb validate` passes but install fails | `entry_point` path wrong | Verify the path in `server.entry_point` matches your actual file |

---

## Minimal working example

The smallest possible connector — one tool, reads one env var:

**`servers/server.mjs`**
```js
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'hello-connector', version: '1.0.0' });

server.registerTool('say_hello', {
  title: 'Say Hello',
  description: 'Returns a greeting.',
  inputSchema: z.object({ name: z.string().describe('Name to greet') }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ name }) => ({
  content: [{ type: 'text', text: `Hello, ${name}!` }],
}));

await server.connect(new StdioServerTransport());
```

**`manifest.json`**
```json
{
  "manifest_version": "0.3",
  "name": "hello-connector",
  "display_name": "Hello Connector",
  "version": "1.0.0",
  "description": "A minimal example connector.",
  "author": { "name": "Your Name" },
  "server": {
    "type": "node",
    "entry_point": "servers/server.mjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/servers/server.mjs"]
    }
  },
  "tools": [{ "name": "say_hello", "description": "Returns a greeting." }]
}
```

Then: `mcpb pack` → `hello-connector-1.0.0.mcpb` → double-click to install.

---

## Official resources

- **MCPB spec & CLI:** https://github.com/modelcontextprotocol/mcpb
- **Building extensions guide:** https://support.claude.com/en/articles/12922929-building-desktop-extensions-with-mcpb
- **Enterprise allowlist:** https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist
- **MCP SDK docs:** https://modelcontextprotocol.io/docs
