---
name: api-test
description: >
  Run a multi-step API automation test — log in, capture a token, call endpoint
  A, extract a value from the response, post it to endpoint B, assert results.
  This skill is the ORCHESTRATOR. It does not send HTTP itself; it composes the
  http-call skill into a sequence and processes each response before the next
  step. Triggered by phrases like "run an API test", "automate this API
  workflow", "chain these requests", "smoke test this API", "regression test
  these endpoints", "login then call", "test scenario for this API". Reads a
  scenario file (YAML/JSON) or a freeform description.
metadata:
  version: "1.0.0"
---

## api-test — Multi-Step API Automation Orchestrator

This skill **does not send HTTP requests directly.** It orchestrates by calling
the `http-call` skill once per step, then processing each response before
deciding the next call. Strict separation:

```
api-test  (this skill)        →  decides what to call, what to check, what to extract
   │
   └─→ http-call (sibling)    →  sends one request, returns one response envelope
```

If you find yourself building a `fetch` invocation here, stop — call `http-call`
instead.

---

### Inputs

A scenario can be:

1. **A YAML / JSON file** the user points to (e.g. `tests/checkout-flow.yaml`).
2. **A freeform description** in the conversation (e.g. *"Log in as alice, list
   her orders, mark the newest as shipped, verify status"*).
3. **A directory** of scenario files — run them all and produce a summary.

The scenario format (recommended YAML, but any structured shape works):

```yaml
name: checkout-flow
env_files: [".env"]            # optional, on top of auto-loaded ones
vars:                           # initial vars usable as {{var}} in any step
  base_url: "https://api.staging.example.com"

steps:
  - name: login
    request:
      method: POST
      url: "{{base_url}}/auth/login"
      body_type: json
      body:
        username: "{{TEST_USER}}"
        password: "{{TEST_PASS}}"
      capture:
        session_token: "$.token"
        user_id: "$.user.id"
    expect:
      status: 200
      body_has: ["token", "user.id"]    # JSONPath fields that must exist

  - name: list_orders
    request:
      method: GET
      url: "{{base_url}}/users/{{user_id}}/orders"
      auth: { type: bearer, token: "{{session_token}}" }
      capture:
        first_order_id: "$.orders[0].id"
    expect:
      status: 200

  - name: ship_order
    request:
      method: PATCH
      url: "{{base_url}}/orders/{{first_order_id}}"
      body_type: json
      body: { status: "shipped" }
      auth: { type: bearer, token: "{{session_token}}" }
    expect:
      status: 200
      body_match:
        status: "shipped"
```

Supported `expect` checks:

| Check | Meaning |
|---|---|
| `status: <int>` or `status: [<int>, ...]` | HTTP status equals (or is in list). |
| `status_lt: <int>` / `status_gte: <int>` | Range checks. |
| `body_has: [<jsonpath>, ...]` | Each JSONPath must resolve to a non-null value. |
| `body_match: { <jsonpath>: <expected> }` | Each path equals the expected value. |
| `header_has: ["Header-Name", ...]` | Headers present (case-insensitive). |
| `elapsed_ms_lt: <int>` | Performance budget. |

---

### Execution loop

For each step (in order):

1. **Resolve `{{vars}}`.** Merge: process.env + scenario `vars` + everything
   accumulated under `captured` from prior steps. Substitute through the
   `request` object.

2. **Call the http-call skill.** Build the request spec exactly per `http-call`'s
   schema (method/url/headers/body/body_type/auth/capture). Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/http.mjs" --json '<spec>' --out /tmp/api-test-step.json
   ```
   Use `--out` for steps that may return large responses; otherwise read stdout
   directly.

3. **Read the response envelope.** Parse the JSON. Pull out:
   - `status`, `status_text`
   - `response.body` (parsed) and `response.body_text`
   - `response.headers`
   - `captured` (if the step requested any captures — these go straight into the
     vars pool for subsequent steps).

4. **Evaluate `expect`.** Each check produces a pass/fail with a message.
   Collect them; do not throw on first failure unless the step has
   `stop_on_fail: true`. Failures still let later independent steps run, which
   is usually what test runners want.

5. **Record the result** in an in-memory run log:
   ```json
   {
     "step": "login",
     "ok": true, "status": 200, "elapsed_ms": 142,
     "captured": { "session_token": "abc...", "user_id": 7 },
     "checks": [ { "name": "status==200", "pass": true } ]
   }
   ```

6. **Continue** to the next step (or stop if `stop_on_fail` triggered and a
   check failed).

When all steps finish, emit a summary table:

```
api-test scenario: checkout-flow
  ✔ login            200  142ms
  ✔ list_orders      200   88ms   captured first_order_id=482
  ✘ ship_order       409  104ms   body_match status: expected "shipped" got "pending"

2/3 passed   total 334ms
```

If invoked with a directory of scenarios, repeat per file and print a final
roll-up.

---

### Boundaries (what this skill does NOT do)

- It does **not** make HTTP calls itself. It calls `http-call`.
- It does **not** know any auth scheme details — it just passes the `auth`
  block straight through. Adding a new scheme is `http-call`'s job, not this
  skill's.
- It does **not** parse arbitrary user files into request specs without showing
  the parsed plan first when the source is freeform.
- It does **not** mutate the scenario file. Captured values live in the run
  log only.

---

### Worked example (freeform request → execution)

User: *"Test our staging users API: log in as alice/correcthorse, then GET
/users/me, expect 200 and email alice@example.com."*

The skill builds two steps:

```yaml
steps:
  - name: login
    request:
      method: POST
      url: "{{BASE_URL}}/auth/login"
      body_type: json
      body: { username: "alice", password: "correcthorse" }
      capture: { token: "$.token" }
    expect: { status: 200 }

  - name: whoami
    request:
      method: GET
      url: "{{BASE_URL}}/users/me"
      auth: { type: bearer, token: "{{token}}" }
    expect:
      status: 200
      body_match: { email: "alice@example.com" }
```

`{{BASE_URL}}` resolves from `.env` (auto-loaded). Invoke `http-call` per step,
chain `token` into step 2, and report the summary.

---

### Tips

- Keep credentials in `.env`, reference as `{{VAR}}` in the scenario. `http-call`
  auto-loads `.env` from `CLAUDE_PROJECT_DIR` (Cowork) or CWD (Claude Code).
- For OAuth2 client_credentials, set `auth` once on the relevant step — the
  http-call skill caches the token across the whole scenario (and across
  scenarios in the same OS session) so you won't re-issue token requests.
- For polling / wait-for-condition, write it as a step with `retry: { until: "$.status == 'ready'", max_attempts: 10, delay_ms: 1000 }` — when a step has `retry`, re-issue the same request via `http-call` until the condition passes or attempts run out.
- Large responses: pass `--out` to `http-call` and read the file. Keep step
  results small in the run log (status + captured vars + check outcomes).
