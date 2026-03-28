# Claude Datadog Plugin

A Claude Code plugin that lets Claude query your Datadog logs, metrics, monitors, and events via MCP.

## Features

- Query Datadog logs
- Retrieve metrics
- List and check monitors
- Browse events

## Installation

### 1. Add the marketplace

```sh
/plugin marketplace add p3nj/claude-datadog-plugin
```

### 2. Install the plugin

```sh
/plugin install datadog@p3nj-plugins
```

Or open the **Discover** tab via `/plugin` and install from there.

### 3. Reload plugins

```sh
/reload-plugins
```

## Configuration

When installing you will be prompted for:

| Field | Description | Default |
|-------|-------------|---------|
| `api_key` | Your Datadog API key | — |
| `app_key` | Your Datadog Application key | — |
| `site` | Your Datadog site | `datadoghq.com` |

You can find your API and App keys in **Datadog → Organization Settings → API Keys / Application Keys**.

Common site values: `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`

## Requirements

- Node.js ≥ 18
- Claude Code with plugin support

## License

MIT
