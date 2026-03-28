/**
 * Datadog API client — shared utility for all tool implementations.
 *
 * Reads credentials from environment variables at call time so that the
 * server process can be started once and pick up credentials on each request.
 */

import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import { DEFAULT_DD_SITE, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { DatadogConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getConfig(): DatadogConfig {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  const site = process.env.DD_SITE || DEFAULT_DD_SITE;

  if (!apiKey || !appKey) {
    throw new Error(
      "DD_API_KEY and DD_APP_KEY environment variables must be set. " +
        "Please configure these in your plugin settings."
    );
  }

  return { apiKey, appKey, site };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function baseUrl(site: string): string {
  return `https://api.${site}`;
}

function authHeaders(config: DatadogConfig): Record<string, string> {
  return {
    "DD-API-KEY": config.apiKey,
    "DD-APPLICATION-KEY": config.appKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function ddGet<T>(
  path: string,
  params?: Record<string, unknown>
): Promise<T> {
  const config = getConfig();
  const url = `${baseUrl(config.site)}${path}`;

  const reqConfig: AxiosRequestConfig = {
    method: "GET",
    url,
    params,
    headers: authHeaders(config),
    timeout: REQUEST_TIMEOUT_MS,
  };

  const response = await axios(reqConfig);
  return response.data as T;
}

export async function ddPost<T>(
  path: string,
  body: unknown
): Promise<T> {
  const config = getConfig();
  const url = `${baseUrl(config.site)}${path}`;

  const reqConfig: AxiosRequestConfig = {
    method: "POST",
    url,
    data: body,
    headers: authHeaders(config),
    timeout: REQUEST_TIMEOUT_MS,
  };

  const response = await axios(reqConfig);
  return response.data as T;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{ errors?: string[] }>;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const detail =
        axiosErr.response.data?.errors?.join(", ") ?? axiosErr.message;

      switch (status) {
        case 400:
          return `Error: Bad request — ${detail}. Check your query syntax and parameters.`;
        case 401:
          return "Error: Authentication failed. Verify that DD_API_KEY and DD_APP_KEY are correct.";
        case 403:
          return "Error: Permission denied. Your API key may not have the required scope.";
        case 404:
          return "Error: Resource not found. Check that the resource ID or query is correct.";
        case 429:
          return "Error: Datadog rate limit exceeded. Please wait before retrying.";
        default:
          return `Error: Datadog API returned status ${status} — ${detail}`;
      }
    }
    if (axiosErr.code === "ECONNABORTED") {
      return "Error: Request timed out. The Datadog API did not respond in time.";
    }
    if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
      return "Error: Cannot reach Datadog API. Check your network connection and DD_SITE value.";
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `Error: Unexpected error — ${msg}`;
}
