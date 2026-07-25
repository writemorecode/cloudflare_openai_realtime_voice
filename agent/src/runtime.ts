/** Coordinates agent-session startup, Realtime lifecycle reporting, and graceful shutdown. */
import type { AgentDispatchMetadataV1 } from "./dispatch-metadata.js";
import type { RealtimeLifecycleObserver } from "./model.js";
import { lifecycleEvent, type AgentLifecycleReporter, type AgentFailureEvent } from "./reporter.js";

export const INITIAL_GREETING_INSTRUCTIONS =
  "Greet the user briefly in English and ask how you can help.";
export const BEGIN_EXAMINATION_INSTRUCTIONS =
  "Begin the examination now. Call get_current_examination_question before speaking; never invent an examination question.";

export interface AgentSessionPort<Room, Assistant> {
  start(options: { readonly agent: Assistant; readonly room: Room }): Promise<void>;
  generateReply(options: {
    readonly instructions: string;
    readonly toolChoice?: "required";
  }): unknown;
  on(event: "error", listener: (event: AgentSessionErrorEvent) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface AgentSessionErrorEvent {
  readonly error: { readonly recoverable: boolean };
}

export interface RunAgentJobOptions<Room, Assistant> {
  readonly metadata: AgentDispatchMetadataV1;
  readonly room: Room;
  readonly connect: () => Promise<void>;
  readonly createSession: (
    observer: RealtimeLifecycleObserver,
  ) => AgentSessionPort<Room, Assistant>;
  readonly createAssistant: () => Assistant;
  readonly reporter: AgentLifecycleReporter;
  readonly initialReplyInstructions?: string;
  readonly requireInitialTool?: boolean;
  readonly registerShutdownCallback?: (callback: () => Promise<void>) => void;
  readonly onBackgroundReportError?: (error: unknown) => void;
}

export async function runAgentJob<Room, Assistant>(
  options: RunAgentJobOptions<Room, Assistant>,
): Promise<void> {
  const lifecycle = new AgentLifecycleCoordinator(
    options.metadata,
    options.reporter,
    options.onBackgroundReportError,
  );
  options.registerShutdownCallback?.(() => lifecycle.flush());
  try {
    const session = options.createSession(lifecycle.providerObserver);
    session.on("error", (event) => lifecycle.sessionError(event));
    session.on("close", () => lifecycle.sessionClosed());
    await session.start({ agent: options.createAssistant(), room: options.room });
    await options.connect();
    await lifecycle.confirmInitialReadiness();
    await session.generateReply({
      instructions: options.initialReplyInstructions ?? INITIAL_GREETING_INSTRUCTIONS,
      ...(options.requireInitialTool !== true ? {} : { toolChoice: "required" as const }),
    });
  } catch {
    const failure: AgentFailureEvent = {
      ...lifecycleEvent(options.metadata, "realtime-failed"),
      errorCode: "agent.initialization_failed",
    };
    await options.reporter.realtimeFailed(failure);
    throw new Error(failure.errorCode);
  }
}

class AgentLifecycleCoordinator {
  readonly providerObserver: RealtimeLifecycleObserver;

  private readonly initialReadiness: Promise<void>;
  private resolveInitialReadiness!: () => void;
  private rejectInitialReadiness!: (error: Error) => void;
  private currentEpoch: number;
  private providerReady = false;
  private initialFailed = false;
  private live = false;
  private interrupted = false;
  private terminal = false;
  private pendingReports: Promise<void> = Promise.resolve();

  constructor(
    private readonly metadata: AgentDispatchMetadataV1,
    private readonly reporter: AgentLifecycleReporter,
    private readonly onBackgroundReportError: (error: unknown) => void = () => undefined,
  ) {
    this.currentEpoch = metadata.transportEpoch;
    this.initialReadiness = new Promise<void>((resolve, reject) => {
      this.resolveInitialReadiness = resolve;
      this.rejectInitialReadiness = reject;
    });
    this.providerObserver = {
      ready: () => {
        if (this.providerReady || this.initialFailed) return;
        this.providerReady = true;
        this.resolveInitialReadiness();
      },
      failed: () => this.failBeforeReady(),
      interrupted: () => this.providerInterrupted(),
      recovered: () => this.providerRecovered(),
    };
  }

  async confirmInitialReadiness(): Promise<void> {
    await this.initialReadiness;
    if (this.initialFailed) throw new Error("agent.realtime_not_ready");
    this.live = true;
    await this.reporter.realtimeReady(this.event("realtime-ready"));
  }

  sessionError(event: AgentSessionErrorEvent): void {
    if (!this.live) {
      if (!event.error.recoverable) this.failBeforeReady();
      return;
    }
    if (this.terminal || event.error.recoverable) return;
    this.terminal = true;
    const failure: AgentFailureEvent = {
      ...this.event("realtime-failed"),
      errorCode: "transport.agent_realtime_failed",
    };
    this.enqueue(() => this.reporter.realtimeFailed(failure));
  }

  sessionClosed(): void {
    if (!this.live) {
      this.failBeforeReady();
      return;
    }
    this.terminal = true;
    const closed = this.event("session-closed");
    this.enqueue(() => this.reporter.sessionClosed(closed));
  }

  async flush(): Promise<void> {
    await this.pendingReports;
  }

  private providerInterrupted(): void {
    if (!this.live || this.interrupted || this.terminal) return;
    this.interrupted = true;
    const interrupted = this.event("realtime-interrupted");
    this.enqueue(() => this.reporter.realtimeInterrupted(interrupted));
  }

  private providerRecovered(): void {
    if (!this.live || !this.interrupted || this.terminal) return;
    this.interrupted = false;
    this.currentEpoch += 1;
    const recovered = this.event("realtime-recovered");
    this.enqueue(() => this.reporter.realtimeRecovered(recovered));
  }

  private failBeforeReady(): void {
    if (this.live || this.initialFailed) return;
    this.initialFailed = true;
    this.rejectInitialReadiness(new Error("agent.realtime_not_ready"));
  }

  private event(kind: string) {
    return lifecycleEvent({ ...this.metadata, transportEpoch: this.currentEpoch }, kind);
  }

  private enqueue(report: () => Promise<void>): void {
    this.pendingReports = this.pendingReports.then(report).catch((error: unknown) => {
      this.onBackgroundReportError(error);
    });
  }
}
