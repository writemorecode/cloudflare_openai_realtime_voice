/** Owns the browser-side LiveKit room and control-WebSocket session for one conversation. */
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

import {
  BrowserMessageType,
  ConversationStateTag,
  ServerMessageType,
  WIRE_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeWireMessage,
  type BrowserWireMessage,
  type ConversationStateDto,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";
import { ConversationClientError, conversationClientError } from "./errors";
import type { ConversationApi, ConversationRuntime, RuntimeEvents, RuntimeFactory } from "./types";

const END_WAIT_MS = 8_000;

export const createConversationRuntime: RuntimeFactory = (api, conversationId, events) =>
  new LiveConversationRuntime(api, conversationId, events);

class LiveConversationRuntime implements ConversationRuntime {
  private readonly room = new Room();
  private control: WebSocket | null = null;
  private state: ConversationStateDto | null = null;
  private audioHost: HTMLElement | null = null;
  private endingWaiter: ((state: ConversationStateDto) => void) | null = null;

  constructor(
    private readonly api: ConversationApi,
    private readonly conversationId: string,
    private readonly events: RuntimeEvents,
  ) {
    this.room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) =>
        this.attachTrack(track, publication, participant),
      )
      .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
      .on(RoomEvent.AudioPlaybackStatusChanged, () =>
        this.events.onPlaybackBlocked(!this.room.canPlaybackAudio),
      );
  }

  async connect(
    initialState: ConversationStateDto,
    audioHost: HTMLElement,
  ): Promise<Result<void, ConversationClientError>> {
    this.state = initialState;
    this.audioHost = audioHost;
    const control = await this.connectControl();
    if (!control.isOk()) return Result.err(control.error);
    const access = await this.api.getLiveKitAccess(this.conversationId);
    if (!access.isOk()) return Result.err(access.error);
    const connected = await Result.tryPromise({
      try: async () => {
        await this.room.connect(access.value.serverUrl, access.value.participantToken);
        await this.room.localParticipant.setMicrophoneEnabled(true);
      },
      catch: (cause) =>
        conversationClientError(
          "livekit_operation_failed",
          "Could not connect to the conversation room.",
          cause,
        ),
    });
    if (!connected.isOk()) return Result.err(connected.error);
    if (!this.room.canPlaybackAudio) this.events.onPlaybackBlocked(true);
    return Result.ok(undefined);
  }

  async enableAudio(): Promise<Result<void, ConversationClientError>> {
    const started = await Result.tryPromise({
      try: () => this.room.startAudio(),
      catch: (cause) =>
        conversationClientError(
          "livekit_operation_failed",
          "Could not start audio playback.",
          cause,
        ),
    });
    if (!started.isOk()) return Result.err(started.error);
    this.events.onPlaybackBlocked(false);
    return Result.ok(undefined);
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<Result<void, ConversationClientError>> {
    const changed = await Result.tryPromise({
      try: () => this.room.localParticipant.setMicrophoneEnabled(enabled),
      catch: (cause) =>
        conversationClientError(
          "livekit_operation_failed",
          "Could not change the microphone state.",
          cause,
        ),
    });
    return changed.isOk() ? Result.ok(undefined) : Result.err(changed.error);
  }

  async requestEnd(): Promise<Result<ConversationStateDto, ConversationClientError>> {
    const state = this.state;
    const socket = this.control;
    const epoch = state === null || !("epoch" in state.transport) ? 0 : state.transport.epoch;
    if (state === null || socket?.readyState !== WebSocket.OPEN || epoch < 1) {
      return Result.err(
        new ConversationClientError(
          "connection_not_ready",
          "The conversation control connection is not ready.",
        ),
      );
    }

    let timeout = 0;
    const ending = new Promise<Result<ConversationStateDto, ConversationClientError>>((resolve) => {
      timeout = window.setTimeout(() => {
        this.endingWaiter = null;
        resolve(
          Result.err(
            new ConversationClientError(
              "shutdown_timeout",
              "The conversation did not begin shutdown in time.",
            ),
          ),
        );
      }, END_WAIT_MS);
      this.endingWaiter = (next) => {
        window.clearTimeout(timeout);
        this.endingWaiter = null;
        resolve(Result.ok(next));
      };
    });
    const sent = this.send([
      WIRE_PROTOCOL_VERSION,
      BrowserMessageType.EndRequested,
      crypto.randomUUID(),
      { expectedRevision: state.revision, epoch, observedAt: Date.now() },
    ]);
    if (!sent.isOk()) {
      window.clearTimeout(timeout);
      this.endingWaiter = null;
      return Result.err(sent.error);
    }
    const next = await ending;
    if (!next.isOk()) return Result.err(next.error);
    const released = await this.api.releaseLiveKitAccess(this.conversationId);
    if (!released.isOk()) return Result.err(released.error);
    const disconnected = await Result.tryPromise({
      try: () => this.room.disconnect(),
      catch: (cause) =>
        conversationClientError(
          "livekit_operation_failed",
          "Could not disconnect from the conversation room.",
          cause,
        ),
    });
    return disconnected.isOk() ? Result.ok(next.value) : Result.err(disconnected.error);
  }

  async close(): Promise<Result<void, ConversationClientError>> {
    return Result.tryPromise({
      try: async () => {
        this.endingWaiter = null;
        this.control?.close(1000, "page closed");
        this.control = null;
        await this.room.disconnect();
        this.audioHost?.replaceChildren();
      },
      catch: (cause) =>
        conversationClientError(
          "livekit_operation_failed",
          "Could not close the conversation runtime cleanly.",
          cause,
        ),
    });
  }

  private async connectControl(): Promise<Result<void, ConversationClientError>> {
    const connected = await Result.tryPromise({
      try: async () => {
        const socket = new WebSocket(
          this.api.websocketUrl(this.conversationId),
          this.api.websocketProtocols(),
        );
        socket.binaryType = "arraybuffer";
        this.control = socket;
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener(
            "error",
            () => reject(new Error("Could not connect to conversation control.")),
            {
              once: true,
            },
          );
        });
        return socket;
      },
      catch: (cause) =>
        conversationClientError(
          "control_connection_failed",
          "Could not connect to conversation control.",
          cause,
        ),
    });
    if (!connected.isOk()) return Result.err(connected.error);
    const socket = connected.value;
    socket.addEventListener("message", (event) => this.handleControlMessage(event));
    return this.send([
      WIRE_PROTOCOL_VERSION,
      BrowserMessageType.ClientHello,
      crypto.randomUUID(),
      {
        conversationId: this.conversationId,
        connectionId: crypto.randomUUID(),
        requestedEpoch:
          this.state !== null && "epoch" in this.state.transport
            ? this.state.transport.epoch
            : null,
        lastKnownRevision: this.state?.revision ?? 0,
      },
    ]);
  }

  private handleControlMessage(event: MessageEvent<ArrayBuffer>): void {
    if (!(event.data instanceof ArrayBuffer)) return;
    const decoded = decodeServerMessage(event.data);
    if (!decoded.isOk()) return;
    const [, type, , body] = decoded.value;
    let next: ConversationStateDto | null = null;
    if (type === ServerMessageType.ServerHello) next = body.currentState;
    if (type === ServerMessageType.StateSnapshot) next = body.state;
    if (next === null || (this.state !== null && next.revision < this.state.revision)) return;
    this.state = next;
    this.events.onState(next);
    if (
      this.endingWaiter !== null &&
      (next.state === ConversationStateTag.Ending || isTerminal(next.state))
    ) {
      this.endingWaiter(next);
    }
  }

  private send(message: BrowserWireMessage): Result<void, ConversationClientError> {
    if (this.control?.readyState !== WebSocket.OPEN) {
      return Result.err(
        new ConversationClientError(
          "control_connection_closed",
          "The conversation control connection is closed.",
        ),
      );
    }
    const encoded = encodeWireMessage(message);
    if (!encoded.isOk()) {
      return Result.err(
        new ConversationClientError(
          "wire_protocol_error",
          "The conversation control message could not be encoded.",
          encoded.error,
        ),
      );
    }
    return Result.try({
      try: () => {
        const bytes = new Uint8Array(encoded.value.byteLength);
        bytes.set(encoded.value);
        this.control?.send(bytes.buffer);
      },
      catch: (cause) =>
        conversationClientError(
          "control_connection_closed",
          "The conversation control message could not be sent.",
          cause,
        ),
    });
  }

  private attachTrack(
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    _participant: RemoteParticipant,
  ): void {
    if (track.kind !== Track.Kind.Audio || this.audioHost === null) return;
    const element = track.attach();
    element.autoplay = true;
    this.audioHost.append(element);
  }
}

function isTerminal(state: ConversationStateDto["state"]): boolean {
  return (
    state === ConversationStateTag.Completed ||
    state === ConversationStateTag.Cancelled ||
    state === ConversationStateTag.Failed
  );
}
