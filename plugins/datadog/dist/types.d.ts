/** Output format for tool responses */
export declare enum ResponseFormat {
    MARKDOWN = "markdown",
    JSON = "json"
}
/** Datadog credentials loaded from environment */
export interface DatadogConfig {
    apiKey: string;
    appKey: string;
    site: string;
}
export interface LogEntry {
    [key: string]: unknown;
    timestamp: string | null;
    service: string | null;
    status: string | null;
    host: string | null;
    message: string | null;
    tags: string[];
}
export interface LogsResult {
    [key: string]: unknown;
    count: number;
    has_more: boolean;
    next_cursor?: string;
    logs: LogEntry[];
}
export interface MetricPoint {
    [key: string]: unknown;
    timestamp: number;
    value: number | null;
}
export interface MetricSeries {
    [key: string]: unknown;
    metric: string | null;
    scope: string | null;
    unit: string | null;
    num_points: number;
    latest_value: number | null;
    points: MetricPoint[];
}
export interface MetricsResult {
    [key: string]: unknown;
    count: number;
    series: MetricSeries[];
}
export interface MonitorEntry {
    [key: string]: unknown;
    id: number | null;
    name: string | null;
    type: string | null;
    status: string | null;
    query: string | null;
    tags: string[];
    created: string | null;
    modified: string | null;
}
export interface MonitorsResult {
    [key: string]: unknown;
    total: number;
    count: number;
    has_more: boolean;
    next_offset?: number;
    monitors: MonitorEntry[];
}
export interface EventEntry {
    [key: string]: unknown;
    id: number | null;
    title: string | null;
    text: string | null;
    priority: string | null;
    alert_type: string | null;
    date_happened: number | null;
    host: string | null;
    tags: string[];
    url: string | null;
}
export interface EventsResult {
    [key: string]: unknown;
    count: number;
    events: EventEntry[];
}
//# sourceMappingURL=types.d.ts.map