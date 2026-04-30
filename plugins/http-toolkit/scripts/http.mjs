#!/usr/bin/env node
// Generic HTTP helper — zero npm deps. Pure Node 18+ built-ins.
//
// Usage:
//   node http.mjs --json '<request-spec-json>'
//   echo '<json>' | node http.mjs --stdin
//   node http.mjs --json '...' --out /tmp/resp.json   (large responses)
//
// Request spec (any JSON-stringifiable):
// {
//   "method": "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS",
//   "url": "https://...",                          // required (absolute)
//   "headers": { "X-Foo": "bar" },                 // optional
//   "query":   { "k": "v" },                       // optional, appended to URL
//   "body":    "string" | { ... } | [ ... ],       // optional
//   "body_type": "json"|"xml"|"form"|"raw"|"none", // default "none"
//   "auth": <auth-spec>,                           // optional, see below
//   "timeout_ms": 30000,                           // default 30000
//   "follow_redirects": true,                      // default true
//   "insecure_tls": false,                         // default false
//   "env": { "VAR": "value" },                     // extra vars for {{interp}}
//   "env_files": [".env"],                         // extra .env paths to load
//   "capture": { "auth_token": "$.access_token" }  // JSONPath-lite extraction
// }
//
// Auth specs (discriminated by `type`):
//   { "type": "none" }
//   { "type": "bearer",  "token": "..." }
//   { "type": "basic",   "username": "...", "password": "..." }
//   { "type": "api_key", "key": "X-API-Key", "value": "...", "in": "header"|"query" }
//   { "type": "oauth2_client_credentials", "token_url": "...",
//     "client_id": "...", "client_secret": "...",
//     "scope": "...", "audience": "..." }
//   { "type": "oauth2_token", "access_token": "...", "token_type": "Bearer" }
//
// All string fields support {{VAR}} interpolation from process.env (after .env loading)
// and request.env (which overrides process.env for this call only).
//
// Output (always JSON on stdout):
// {
//   "ok": true|false, "status": 200, "status_text": "OK",
//   "url": "<final url>", "elapsed_ms": 123,
//   "request": { "method","url","headers","body" },     (auth redacted)
//   "response": { "headers", "body" (parsed if json), "body_text", "body_type": "json|xml|text" },
//   "captured": { ... }                                  (only if capture spec given)
// }
// Exit code: 0 on success (HTTP < 400), 2 on HTTP >= 400, 3 on transport/parse error.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// ---------- arg parse ----------
const args = process.argv.slice(2);
let jsonArg = null;
let useStdin = false;
let outPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") jsonArg = args[++i];
  else if (a === "--stdin") useStdin = true;
  else if (a === "--out") outPath = args[++i];
  else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: node http.mjs --json '<spec>' | --stdin [--out <path>]\n",
    );
    process.exit(0);
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

let specRaw;
if (jsonArg) specRaw = jsonArg;
else if (useStdin) specRaw = await readStdin();
else {
  fail("No input. Use --json '<spec>' or --stdin.");
}

let spec;
try {
  spec = JSON.parse(specRaw);
} catch (e) {
  fail(`Invalid JSON spec: ${e.message}`);
}

// ---------- .env auto-load ----------
function loadEnvFile(path, overwrite = false) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (overwrite || !(key in process.env)) {
      process.env[key] = val;
      n++;
    }
  }
  return n;
}

// 1. CLAUDE_PROJECT_DIR/.env (cowork)  2. CWD/.env  3. spec.env_files (explicit, overwrites)
const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (projectDir) loadEnvFile(join(projectDir, ".env"));
loadEnvFile(join(process.cwd(), ".env"));
if (Array.isArray(spec.env_files)) {
  for (const f of spec.env_files) {
    const p = isAbsolute(f) ? f : join(process.cwd(), f);
    loadEnvFile(p, true);
  }
}

if (spec.insecure_tls === true) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ---------- {{VAR}} interpolation ----------
function interp(value, extra) {
  if (value == null) return value;
  const env = { ...process.env, ...(extra || {}) };
  if (typeof value === "string") {
    return value.replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g,
      (m, k) => (env[k] != null ? String(env[k]) : m),
    );
  }
  if (Array.isArray(value)) return value.map((v) => interp(v, extra));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interp(v, extra);
    return out;
  }
  return value;
}

const extraEnv = spec.env || {};
spec = interp(spec, extraEnv);

// ---------- helpers ----------
function hasHeader(h, name) {
  const lower = name.toLowerCase();
  return Object.keys(h).some((k) => k.toLowerCase() === lower);
}
function fail(msg, payload = null) {
  const out = { ok: false, error: msg, ...(payload || {}) };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(3);
}

// ---------- OAuth2 client_credentials cache (process-scoped) ----------
// File-backed cache so successive `node http.mjs` invocations share tokens.
const TOKEN_CACHE_FILE = join(
  process.env.TMPDIR || "/tmp",
  "http-toolkit-token-cache.json",
);
function readTokenCache() {
  try {
    return existsSync(TOKEN_CACHE_FILE)
      ? JSON.parse(readFileSync(TOKEN_CACHE_FILE, "utf8"))
      : {};
  } catch {
    return {};
  }
}
function writeTokenCache(c) {
  try {
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
async function getOAuth2Token(auth) {
  const key = `${auth.token_url}|${auth.client_id}|${auth.scope || ""}|${auth.audience || ""}`;
  const cache = readTokenCache();
  const now = Date.now();
  const hit = cache[key];
  if (hit && hit.expiresAt > now + 5000) return { ...hit, fromCache: true };
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", auth.client_id);
  params.set("client_secret", auth.client_secret);
  if (auth.scope) params.set("scope", auth.scope);
  if (auth.audience) params.set("audience", auth.audience);
  const r = await fetch(auth.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await r.text();
  if (!r.ok)
    throw new Error(`OAuth2 token failed: ${r.status} ${r.statusText} ${text}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OAuth2 token response not JSON: ${text}`);
  }
  const ttl = Number(data.expires_in) || 3600;
  const entry = {
    access_token: data.access_token,
    token_type: data.token_type || "Bearer",
    scope: data.scope,
    expiresAt: now + (ttl - 30) * 1000,
  };
  cache[key] = entry;
  writeTokenCache(cache);
  return { ...entry, fromCache: false };
}

async function applyAuth(auth, headers, queryParams) {
  if (!auth || auth.type === "none") return;
  switch (auth.type) {
    case "bearer":
      if (!hasHeader(headers, "authorization"))
        headers["Authorization"] = `Bearer ${auth.token}`;
      return;
    case "basic": {
      if (!hasHeader(headers, "authorization")) {
        const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString(
          "base64",
        );
        headers["Authorization"] = `Basic ${b64}`;
      }
      return;
    }
    case "api_key":
      if (auth.in === "query") queryParams.append(auth.key, auth.value);
      else if (!hasHeader(headers, auth.key)) headers[auth.key] = auth.value;
      return;
    case "oauth2_token":
      if (!hasHeader(headers, "authorization"))
        headers["Authorization"] =
          `${auth.token_type || "Bearer"} ${auth.access_token}`;
      return;
    case "oauth2_client_credentials": {
      const tok = await getOAuth2Token(auth);
      if (!hasHeader(headers, "authorization"))
        headers["Authorization"] = `${tok.token_type} ${tok.access_token}`;
      return;
    }
    default:
      throw new Error(`Unknown auth type: ${auth.type}`);
  }
}

function encodeBody(body, bodyType, headers) {
  if (bodyType === "none" || body == null) return undefined;
  const setCT = (ct) => {
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = ct;
  };
  switch (bodyType) {
    case "json":
      setCT("application/json");
      return typeof body === "string" ? body : JSON.stringify(body);
    case "xml":
      setCT("application/xml");
      if (typeof body !== "string")
        throw new Error("body_type 'xml' requires string body");
      return body;
    case "form": {
      setCT("application/x-www-form-urlencoded");
      if (typeof body === "string") return body;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) sp.append(k, String(v));
      return sp.toString();
    }
    case "raw":
      if (typeof body !== "string")
        throw new Error("body_type 'raw' requires string body");
      return body;
    default:
      throw new Error(`Unknown body_type: ${bodyType}`);
  }
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "authorization" && typeof v === "string") {
      out[k] = v.slice(0, 12) + "…[redacted]";
    } else out[k] = v;
  }
  return out;
}

// ---------- minimal JSONPath-lite for `capture` ----------
// Supports: $, .field, [n], .a.b[0].c
function extractPath(obj, path) {
  if (typeof path !== "string" || !path.startsWith("$")) return undefined;
  let cur = obj;
  const tokens = path.slice(1).match(/\.[A-Za-z_][\w-]*|\[\d+\]/g) || [];
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.startsWith(".")) cur = cur[t.slice(1)];
    else cur = cur[Number(t.slice(1, -1))];
  }
  return cur;
}

// ---------- main ----------
async function run() {
  const method = (spec.method || "GET").toUpperCase();
  if (!spec.url) fail("'url' is required");

  const u = new URL(spec.url);
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query))
      u.searchParams.append(k, String(v));
  }

  const headers = {};
  if (spec.headers)
    for (const [k, v] of Object.entries(spec.headers)) headers[k] = String(v);

  if (spec.auth) await applyAuth(spec.auth, headers, u.searchParams);

  const bodyType = spec.body_type || "none";
  const encodedBody = encodeBody(spec.body, bodyType, headers);

  const timeoutMs = Number(spec.timeout_ms) || 30000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const startedAt = Date.now();
  let resp;
  try {
    resp = await fetch(u.toString(), {
      method,
      headers,
      body: encodedBody,
      redirect: spec.follow_redirects === false ? "manual" : "follow",
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    fail(`Request failed: ${e.name}: ${e.message}`, {
      request: { method, url: u.toString(), headers: redactHeaders(headers) },
    });
  }
  clearTimeout(timer);
  const elapsedMs = Date.now() - startedAt;

  const respHeaders = {};
  for (const [k, v] of resp.headers.entries()) respHeaders[k] = v;
  const text = await resp.text();
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  let parsed;
  let bodyTypeDetected = "text";
  let parseError;
  if (ct.includes("json")) {
    bodyTypeDetected = "json";
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parseError = e.message;
    }
  } else if (ct.includes("xml")) bodyTypeDetected = "xml";

  const captured = {};
  if (spec.capture && parsed !== undefined) {
    for (const [k, p] of Object.entries(spec.capture)) {
      captured[k] = extractPath(parsed, p);
    }
  }

  const envelope = {
    ok: resp.ok,
    status: resp.status,
    status_text: resp.statusText,
    url: resp.url,
    elapsed_ms: elapsedMs,
    request: {
      method,
      url: u.toString(),
      headers: redactHeaders(headers),
      body_type: bodyType,
      ...(encodedBody != null && encodedBody.length < 4000
        ? { body: encodedBody }
        : encodedBody != null
          ? { body_length: Buffer.byteLength(encodedBody, "utf8") }
          : {}),
    },
    response: {
      headers: respHeaders,
      body_type_detected: bodyTypeDetected,
      ...(parsed !== undefined ? { body: parsed } : {}),
      ...(parseError ? { parse_error: parseError } : {}),
    },
    ...(spec.capture ? { captured } : {}),
  };

  // Always include text body (truncated for large responses)
  const MAX = 25_000;
  const fullLen = Buffer.byteLength(text, "utf8");
  if (fullLen > MAX) {
    envelope.response.body_text = text.slice(0, MAX);
    envelope.response.truncated = true;
    envelope.response.full_length = fullLen;
  } else {
    envelope.response.body_text = text;
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(envelope, null, 2));
    process.stdout.write(
      JSON.stringify(
        {
          ok: envelope.ok,
          status: envelope.status,
          captured: envelope.captured,
          out: outPath,
          full_length: fullLen,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  }

  process.exit(envelope.ok ? 0 : 2);
}

run().catch((e) => fail(`Unexpected error: ${e.message}`));
