---
name: http-call
description: >
  Send a single HTTP request and return the parsed response. This is a pure
  primitive — one request in, one response out. It does NOT loop, chain, assert,
  or interpret. Use it whenever you need to hit an HTTP endpoint: GET / POST /
  PUT / PATCH / DELETE / HEAD / OPTIONS, with JSON or XML or form or raw bodies,
  custom headers, query params, and any of these auth schemes — none, bearer,
  basic, api_key (header or query), oauth2_client_credentials, oauth2_token.
  Auto-loads .env from CLAUDE_PROJECT_DIR (Cowork) or current directory (Claude
  Code). Triggered by phrases like "send a request", "GET this URL", "POST JSON
  to", "call this API", "hit endpoint X". Other skills (e.g. api-test) call this
  skill to perform their HTTP operations.
metadata:
  version: "1.0.0"
---

## http-call — Single HTTP Request Primitive

**One job:** send one HTTP request, return one response envelope. Nothing else.

This skill does **not** chain requests, assert outcomes, run loops, or interpret
results. Orchestration belongs to caller skills (e.g. `api-test`). Keep this
boundary clean.

---

### How to invoke

The skill is implemented as a Node script — `scripts/http.mjs` — bundled with
this plugin. Run it via Bash. No `npm install` is needed; the script uses only
Node 18+ built-ins.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '<REQUEST_SPEC_JSON>'
```

If `${CLAUDE_PLUGIN_ROOT}` isn't set in your environment, substitute the
absolute path to the plugin directory.

For large request specs, pipe via stdin instead of `--json`:

```bash
echo '<spec>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --stdin
```

For huge responses, add `--out /tmp/response.json` — stdout will then return a
small summary and the full envelope is written to disk.

---

### Request spec

A JSON object with these fields. **Everything is per-call** — there is no
plugin-level config to update when switching endpoints or credentials.

| Field | Type | Required | Notes |
|---|---|---|---|
| `method` | string | no (default `GET`) | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` |
| `url` | string | **yes** | Absolute URL. Supports `{{VAR}}` interpolation. |
| `headers` | object | no | `{ "X-Foo": "bar" }`. Values support `{{VAR}}`. |
| `query` | object | no | Query params merged into the URL. |
| `body` | string \| object \| array | no | Request body. |
| `body_type` | string | no (default `none`) | `json` / `xml` / `form` / `raw` / `none`. Sets `Content-Type` automatically when not already set. |
| `auth` | object | no | See **Auth** below. |
| `timeout_ms` | number | no (default `30000`) | Per-request timeout. |
| `follow_redirects` | bool | no (default `true`) | |
| `insecure_tls` | bool | no (default `false`) | Disables TLS verification — testing only. |
| `env` | object | no | Extra `{{VAR}}` vars, override `process.env` for this call only. |
| `env_files` | string[] | no | Extra `.env` paths to load (overwriting). |
| `capture` | object | no | Map of `name → JSONPath` to extract from the response body. |

**Auth specs** (discriminated by `type`):

```json
{ "type": "none" }
{ "type": "bearer",  "token": "{{API_TOKEN}}" }
{ "type": "basic",   "username": "u", "password": "p" }
{ "type": "api_key", "key": "X-API-Key", "value": "{{KEY}}", "in": "header" }
{ "type": "api_key", "key": "api_key",   "value": "{{KEY}}", "in": "query" }
{ "type": "oauth2_client_credentials",
  "token_url": "https://auth.example.com/oauth/token",
  "client_id": "{{CID}}", "client_secret": "{{CS}}",
  "scope": "read:all", "audience": "https://api.example.com" }
{ "type": "oauth2_token", "access_token": "{{TOK}}", "token_type": "Bearer" }
```

OAuth2 client_credentials tokens are cached on disk (`$TMPDIR/http-toolkit-token-cache.json`)
keyed by `(token_url, client_id, scope, audience)` and reused across invocations
until ~30s before expiry. So an automation suite that hits 100 endpoints with
the same auth issues exactly **one** token exchange.

---

### Response envelope (always JSON)

```json
{
  "ok": true,
  "status": 200, "status_text": "OK",
  "url": "<final URL after redirects>",
  "elapsed_ms": 142,
  "request":  { "method", "url", "headers" (auth redacted), "body_type", "body" },
  "response": {
    "headers": { ... },
    "body_type_detected": "json|xml|text",
    "body":      <parsed JSON, when applicable>,
    "body_text": "<raw text>",
    "truncated": false, "full_length": 1234
  },
  "captured": { "auth_token": "..." }   // only when `capture` was provided
}
```

**Exit codes:** `0` on HTTP < 400, `2` on HTTP >= 400, `3` on transport / parse
errors. Caller skills should branch on these.

---

### Examples

**1. Plain GET**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '{
  "url": "https://httpbin.org/get"
}'
```

**2. POST JSON with bearer token from .env**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '{
  "method": "POST",
  "url": "https://api.example.com/widgets",
  "body_type": "json",
  "body": { "name": "thing", "qty": 3 },
  "auth": { "type": "bearer", "token": "{{API_TOKEN}}" }
}'
```

**3. PUT XML with custom header**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '{
  "method": "PUT",
  "url": "https://soap.example.com/svc",
  "headers": { "SOAPAction": "Create" },
  "body_type": "xml",
  "body": "<root><x>1</x></root>"
}'
```

**4. Login + capture token (so a caller can reuse it)**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '{
  "method": "POST",
  "url": "https://api.example.com/login",
  "body_type": "json",
  "body": { "username": "{{USER}}", "password": "{{PASS}}" },
  "capture": { "session_token": "$.token", "user_id": "$.user.id" }
}'
```

The orchestrator skill reads `captured.session_token` from the response envelope
and threads it into the next call.

**5. OAuth2 client_credentials, then call API**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '{
  "method": "GET",
  "url": "https://api.example.com/me",
  "auth": {
    "type": "oauth2_client_credentials",
    "token_url": "https://auth.example.com/oauth/token",
    "client_id": "{{CID}}",
    "client_secret": "{{CS}}",
    "scope": "read:profile"
  }
}'
```

---

### Boundaries (what this skill does NOT do)

- It does **not** loop, retry, or chain — issue a single request and exit.
- It does **not** assert response content — caller skills do that.
- It does **not** generate test data — pass it in.
- It does **not** persist state across calls beyond the OAuth token cache.

For multi-step workflows (login → call → call → assert), invoke the **api-test**
skill instead. That skill calls *this* skill once per step.
