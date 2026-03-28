/** Output format for tool responses */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Datadog credentials loaded from environment */
export interface DatadogConfig {
  apiKey: string;
  appKey: string;
  site: string;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  [key: string]: unknown;
  timestamp: string | null;
  service: string | null;
  status: string | null;
  host: string | null;
  message: string | null;
  tags: string[];

  // Prismatic execution fields (may be null if not present)
  severity: string | null;
  severityNumber: number | null;
  logType: string | null;
  instance: string | null;
  instanceId: string | null;
  integration: string | null;
  integrationId: string | null;
  flow: string | null;
  flowId: string | null;
  flowConfigId: string | null;
  executionId: string | null;
  retryAttempt: number | null;
  isTestExecution: boolean | null;
  succeeded: boolean | null;
  duration: number | null;
}

export interface LogsResult {
  [key: string]: unknown;
  count: number;
  has_more: boolean;
  next_cursor?: string;
  logs: LogEntry[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

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
