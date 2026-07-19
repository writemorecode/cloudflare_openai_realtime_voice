import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

import { ConversationStateTag } from "../../src/domain/conversation-state-machine";
import {
  BrowserMessageType,
  ServerMessageType,
  WIRE_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeWireMessage,
  type BrowserWireMessage,
} from "../../src/shared/protocol/conversation-wire";
import type { ConversationStateDto } from "../../src/worker/http/conversation-state-dto";
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

  async connect(initialState: ConversationStateDto, audioHost: HTMLElement): Promise<void> {
    this.state = initialState;
    this.audioHost = audioHost;
    await this.connectControl();
    const access = await this.api.getLiveKitAccess(this.conversationId);
    await this.room.connect(access.serverUrl, access.participantToken);
    await this.room.localParticipant.setMicrophoneEnabled(true);
    if (!this.room.canPlaybackAudio) this.events.onPlaybackBlocked(true);
  }

  async enableAudio(): Promise<void> {
    await this.room.startAudio();
    this.events.onPlaybackBlocked(false);
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  async requestEnd(): Promise<ConversationStateDto> {
    const state = this.state;
    const socket = this.control;
    const epoch = state === null || !("epoch" in state.transport) ? 0 : state.transport.epoch;
    if (state === null || socket?.readyState !== WebSocket.OPEN || epoch < 1) {
      throw new Error("The conversation control connection is not ready.");
    }

    const ending = new Promise<ConversationStateDto>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.endingWaiter = null;
        reject(new Error("The conversation did not begin shutdown in time."));
      }, END_WAIT_MS);
      this.endingWaiter = (next) => {
        window.clearTimeout(timeout);
        this.endingWaiter = null;
        resolve(next);
      };
    });
    this.send([
      WIRE_PROTOCOL_VERSION,
      BrowserMessageType.EndRequested,
      crypto.randomUUID(),
      { expectedRevision: state.revision, epoch, observedAt: Date.now() },
    ]);
    const next = await ending;
    await this.api.releaseLiveKitAccess(this.conversationId);
    await this.room.disconnect();
    return next;
  }

  async close(): Promise<void> {
    this.endingWaiter = null;
    this.control?.close(1000, "page closed");
    this.control = null;
    await this.room.disconnect();
    this.audioHost?.replaceChildren();
  }

  private async connectControl(): Promise<void> {
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
    socket.addEventListener("message", (event) => this.handleControlMessage(event));
    this.send([
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
    const [, type, , body] = decodeServerMessage(event.data);
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

  private send(message: BrowserWireMessage): void {
    if (this.control?.readyState !== WebSocket.OPEN) {
      throw new Error("The conversation control connection is closed.");
    }
    const encoded = encodeWireMessage(message);
    const bytes = new Uint8Array(encoded.byteLength);
    bytes.set(encoded);
    this.control.send(bytes.buffer);
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

function isTerminal(state: ConversationStateTag): boolean {
  return (
    state === ConversationStateTag.Completed ||
    state === ConversationStateTag.Cancelled ||
    state === ConversationStateTag.Failed
  );
}
