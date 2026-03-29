# p3nj-market

A collection of skills for Claude Code, packaged as plugins.

## Plugins

| Plugin | Description |
|--------|-------------|
| [datadog-log-analyst](plugins/datadog-log-analysis) | Analyse Datadog logs for Prismatic integrations with streaming accumulator for million-log datasets |
| [mcp-connector-builder](plugins/mcp-connector-builder) | Build and package custom MCP servers as Claude Desktop Extension bundles (.mcpb) |

## Structure

```
plugins/
  <plugin-name>/
    .claude-plugin/
      plugin.json        # Plugin metadata
    skills/
      <skill-name>/
        SKILL.md          # Skill definition
        scripts/          # Supporting scripts (optional)
```

## Installation

Each plugin can be installed directly into Claude Code from this repository.
