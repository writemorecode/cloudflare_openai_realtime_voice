import type { AgentDispatchMetadataV1 } from "./dispatch-metadata.js";

export interface AgentLifecycleEvent {
  readonly eventId: string;
  readonly conversationId: string;
  readonly roomName: string;
  readonly transportEpoch: number;
  readonly occurredAt: string;
}

export interface AgentFailureEvent extends AgentLifecycleEvent {
  readonly errorCode: string;
}

export interface AgentLifecycleReporter {
  realtimeReady(event: AgentLifecycleEvent): Promise<void>;
  realtimeInterrupted(event: AgentLifecycleEvent): Promise<void>;
  realtimeRecovered(event: AgentLifecycleEvent): Promise<void>;
  realtimeFailed(event: AgentFailureEvent): Promise<void>;
  sessionClosed(event: AgentLifecycleEvent): Promise<void>;
}

export class NoopAgentLifecycleReporter implements AgentLifecycleReporter {
  readonly realtimeReady = async (_event: AgentLifecycleEvent): Promise<void> => undefined;
  readonly realtimeInterrupted = async (_event: AgentLifecycleEvent): Promise<void> => undefined;
  readonly realtimeRecovered = async (_event: AgentLifecycleEvent): Promise<void> => undefined;
  readonly realtimeFailed = async (_event: AgentFailureEvent): Promise<void> => undefined;
  readonly sessionClosed = async (_event: AgentLifecycleEvent): Promise<void> => undefined;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface LifecycleReporterDeliveryOptions {
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly sleep?: Sleep;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;

export class HttpAgentLifecycleReporter implements AgentLifecycleReporter {
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: Sleep;

  constructor(
    private readonly endpoint: string,
    private readonly callbackToken: string,
    private readonly fetch: Fetch = globalThis.fetch,
    options: LifecycleReporterDeliveryOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sleep = options.sleep ?? delay;
  }

  readonly realtimeReady = (event: AgentLifecycleEvent): Promise<void> =>
    this.send("realtime_ready", event);
  readonly realtimeInterrupted = (event: AgentLifecycleEvent): Promise<void> =>
    this.send("realtime_interrupted", event);
  readonly realtimeRecovered = (event: AgentLifecycleEvent): Promise<void> =>
    this.send("realtime_recovered", event);
  readonly realtimeFailed = (event: AgentFailureEvent): Promise<void> =>
    this.send("realtime_failed", event);
  readonly sessionClosed = (event: AgentLifecycleEvent): Promise<void> =>
    this.send("session_closed", event);

  private async send(
    type:
      | "realtime_ready"
      | "realtime_interrupted"
      | "realtime_recovered"
      | "realtime_failed"
      | "session_closed",
    event: AgentLifecycleEvent | AgentFailureEvent,
  ): Promise<void> {
    const body = JSON.stringify({ version: 1, type, ...event });
    let failureCode = "network";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.callbackToken}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        failureCode = String(response.status);
        if (!isRetryableStatus(response.status)) {
          throw new Error(`agent.lifecycle_report_failed:${failureCode}`);
        }
      } catch (error) {
        if (controller.signal.aborted) failureCode = "timeout";
        if (isLifecycleReportFailure(error)) throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new Error(`agent.lifecycle_report_failed:${failureCode}`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isLifecycleReportFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("agent.lifecycle_report_failed:");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createLifecycleReporter(config: {
  readonly controlPlaneUrl: string | null;
  readonly callbackToken: string | null;
}): AgentLifecycleReporter {
  if (config.controlPlaneUrl === null || config.callbackToken === null) {
    throw new Error("Agent control-plane reporting is not configured");
  }
  return new HttpAgentLifecycleReporter(
    `${config.controlPlaneUrl}/v1/integrations/livekit/agent-events`,
    config.callbackToken,
  );
}

export function lifecycleEvent(
  metadata: AgentDispatchMetadataV1,
  kind: string,
): AgentLifecycleEvent {
  return {
    eventId: `agent:${metadata.conversationId}:${metadata.transportEpoch}:${kind}`,
    conversationId: metadata.conversationId,
    roomName: metadata.roomName,
    transportEpoch: metadata.transportEpoch,
    occurredAt: new Date().toISOString(),
  };
}
