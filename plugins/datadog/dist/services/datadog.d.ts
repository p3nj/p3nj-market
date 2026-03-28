/**
 * Datadog API client — shared utility for all tool implementations.
 *
 * Reads credentials from environment variables at call time so that the
 * server process can be started once and pick up credentials on each request.
 */
import type { DatadogConfig } from "../types.js";
export declare function getConfig(): DatadogConfig;
export declare function ddGet<T>(path: string, params?: Record<string, unknown>): Promise<T>;
export declare function ddPost<T>(path: string, body: unknown): Promise<T>;
export declare function handleApiError(error: unknown): string;
//# sourceMappingURL=datadog.d.ts.map