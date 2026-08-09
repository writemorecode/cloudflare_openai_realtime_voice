/** Owns one browser-to-OpenAI WebRTC session and its mixed-audio recording. */
/* oxlint-disable eslint-js/no-restricted-syntax -- Browser media APIs throw; public methods translate failures to Result values. */
import {
  BrowserMessageType,
  ConversationStateTag,
  ServerMessageType,
  WIRE_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeWireMessage,
  type BrowserWireMessage,
  type ConversationStateDto,
  type RecordingUpload,
  type UploadedRecordingPart,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

import { ConversationClientError, conversationClientError } from "./errors";
import type { ConversationApi, ConversationRuntime, RuntimeEvents, RuntimeFactory } from "./types";

const END_WAIT_MS = 8_000;
const MULTIPART_SIZE = 10 * 1024 * 1024;

export const createConversationRuntime: RuntimeFactory = (api, conversationId, events) =>
  new RealtimeConversationRuntime(api, conversationId, events);

class RealtimeConversationRuntime implements ConversationRuntime {
  private control: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private readonly recordingChunks: Blob[] = [];
  private recordingUpload: RecordingUpload | null = null;
  private recordingFinalized = false;
  private finalization: Promise<Result<ConversationStateDto, ConversationClientError>> | null =
    null;
  private remoteAudio: HTMLAudioElement | null = null;
  private state: ConversationStateDto | null = null;
  private audioHost: HTMLElement | null = null;
  private endingWaiter: ((state: ConversationStateDto) => void) | null = null;
  private readonly completedToolCalls = new Set<string>();

  constructor(
    private readonly api: ConversationApi,
    private readonly conversationId: string,
    private readonly events: RuntimeEvents,
  ) {}

  async connect(
    initialState: ConversationStateDto,
    audioHost: HTMLElement,
  ): Promise<Result<void, ConversationClientError>> {
    this.state = initialState;
    this.audioHost = audioHost;
    const control = await this.connectControl();
    if (!control.isOk()) return control;

    const connected = await Result.tryPromise({
      try: async () => {
        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.microphone = microphone;
        const audioContext = new AudioContext();
        this.audioContext = audioContext;
        void audioContext.resume().catch(() => this.events.onPlaybackBlocked(true));
        const recordingDestination = audioContext.createMediaStreamDestination();
        audioContext.createMediaStreamSource(microphone).connect(recordingDestination);

        const peer = new RTCPeerConnection();
        this.peer = peer;
        peer.addTrack(microphone.getAudioTracks()[0]!, microphone);
        peer.addEventListener("track", (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          this.attachRemoteAudio(stream, audioHost);
          audioContext.createMediaStreamSource(stream).connect(recordingDestination);
        });

        const channel = peer.createDataChannel("oai-events");
        this.dataChannel = channel;
        channel.addEventListener("message", (event) => void this.handleRealtimeEvent(event));
        const channelOpen = waitForDataChannel(channel);

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (offer.sdp === undefined) throw new Error("WebRTC did not create an SDP offer.");
        const answer = await this.api.createRealtimeCall(this.conversationId, offer.sdp);
        if (!answer.isOk()) throw answer.error;
        await peer.setRemoteDescription({ type: "answer", sdp: answer.value });
        await channelOpen;

        const mimeType = supportedRecordingType();
        const recorder = new MediaRecorder(recordingDestination.stream, { mimeType });
        this.recorder = recorder;
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) this.recordingChunks.push(event.data);
        });
        recorder.start(1_000);

        const upload = await this.api.beginRecording(
          this.conversationId,
          recorder.mimeType || mimeType,
        );
        if (!upload.isOk()) throw upload.error;
        this.recordingUpload = upload.value;
        channel.send(JSON.stringify({ type: "response.create" }));
      },
      catch: (cause) =>
        conversationClientError(
          "realtime_operation_failed",
          "Could not connect to the AI examiner.",
          cause,
        ),
    });
    return connected.isOk() ? Result.ok(undefined) : Result.err(connected.error);
  }

  async enableAudio(): Promise<Result<void, ConversationClientError>> {
    const audio = this.remoteAudio;
    if (audio === null) {
      return Result.err(
        new ConversationClientError("connection_not_ready", "Examiner audio is not ready."),
      );
    }
    const played = await Result.tryPromise({
      try: async () => {
        if (this.audioContext?.state === "suspended") await this.audioContext.resume();
        await audio.play();
      },
      catch: (cause) =>
        conversationClientError("media_operation_failed", "Could not start audio playback.", cause),
    });
    if (!played.isOk()) return played;
    this.events.onPlaybackBlocked(false);
    return Result.ok(undefined);
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<Result<void, ConversationClientError>> {
    const track = this.microphone?.getAudioTracks()[0];
    if (track === undefined) {
      return Result.err(
        new ConversationClientError("connection_not_ready", "The microphone is not ready."),
      );
    }
    track.enabled = enabled;
    return Result.ok(undefined);
  }

  async requestEnd(): Promise<Result<ConversationStateDto, ConversationClientError>> {
    const ending = await this.requestEndingState();
    if (!ending.isOk()) return ending;
    return this.finalizeRecording();
  }

  private finalizeRecording(): Promise<Result<ConversationStateDto, ConversationClientError>> {
    if (this.finalization !== null) return this.finalization;
    const upload = this.recordingUpload;
    if (upload === null) {
      return Promise.resolve(
        Result.err(
          new ConversationClientError("connection_not_ready", "The recording upload is not ready."),
        ),
      );
    }

    this.finalization = Result.tryPromise({
      try: async () => {
        const recording = await this.stopRecorder();
        this.closeMedia();
        const started = await this.api.beginRecordingUpload(this.conversationId, upload);
        if (!started.isOk()) throw started.error;

        const count = Math.max(1, Math.ceil(recording.size / MULTIPART_SIZE));
        const parts = await Promise.all(
          Array.from({ length: count }, async (_, index): Promise<UploadedRecordingPart> => {
            const body = recording.slice(
              index * MULTIPART_SIZE,
              (index + 1) * MULTIPART_SIZE,
              recording.type,
            );
            const uploaded = await this.api.uploadRecordingPart(
              this.conversationId,
              upload,
              index + 1,
              body,
            );
            if (!uploaded.isOk()) throw uploaded.error;
            return uploaded.value;
          }),
        );
        const completed = await this.api.completeRecordingUpload(
          this.conversationId,
          upload,
          parts,
        );
        if (!completed.isOk()) throw completed.error;
        this.recordingFinalized = true;
        this.state = completed.value;
        this.events.onState(completed.value);
        return completed.value;
      },
      catch: (cause) =>
        conversationClientError(
          "recording_upload_failed",
          "The mixed recording could not be uploaded.",
          cause,
        ),
    });
    return this.finalization;
  }

  async close(): Promise<Result<void, ConversationClientError>> {
    const upload = this.recordingUpload;
    this.endingWaiter = null;
    this.control?.close(1000, "page closed");
    this.control = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.closeMedia();
    this.audioHost?.replaceChildren();
    if (upload !== null && !this.recordingFinalized) {
      await this.api.abortRecordingUpload(this.conversationId, upload);
    }
    return Result.ok(undefined);
  }

  private async requestEndingState(): Promise<
    Result<ConversationStateDto, ConversationClientError>
  > {
    const state = this.state;
    const socket = this.control;
    const epoch = state === null || !("epoch" in state.transport) ? 0 : state.transport.epoch;
    if (state === null || socket?.readyState !== WebSocket.OPEN || epoch < 1) {
      return Result.err(
        new ConversationClientError("connection_not_ready", "The conversation is not ready."),
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
    const sent = this.sendControl([
      WIRE_PROTOCOL_VERSION,
      BrowserMessageType.EndRequested,
      crypto.randomUUID(),
      { expectedRevision: state.revision, epoch, observedAt: Date.now() },
    ]);
    if (!sent.isOk()) {
      window.clearTimeout(timeout);
      this.endingWaiter = null;
      return sent;
    }
    return ending;
  }

  private stopRecorder(): Promise<Blob> {
    const recorder = this.recorder;
    if (recorder === null || recorder.state === "inactive") {
      return Promise.resolve(new Blob(this.recordingChunks, { type: recorder?.mimeType ?? "" }));
    }
    return new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => resolve(new Blob(this.recordingChunks, { type: recorder.mimeType })),
        { once: true },
      );
      recorder.stop();
    });
  }

  private closeMedia(): void {
    this.dataChannel?.close();
    this.dataChannel = null;
    this.peer?.close();
    this.peer = null;
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    this.microphone = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.remoteAudio?.pause();
  }

  private attachRemoteAudio(stream: MediaStream, host: HTMLElement): void {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = stream;
    host.replaceChildren(audio);
    this.remoteAudio = audio;
    void audio.play().then(
      () => this.events.onPlaybackBlocked(false),
      () => this.events.onPlaybackBlocked(true),
    );
  }

  private async handleRealtimeEvent(message: MessageEvent<string>): Promise<void> {
    if (typeof message.data !== "string") return;
    let event: unknown;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!isResponseDone(event)) return;
    for (const item of event.response.output) {
      if (item.type !== "function_call" || this.completedToolCalls.has(item.call_id)) continue;
      this.completedToolCalls.add(item.call_id);
      // oxlint-disable-next-line no-await-in-loop -- tool calls preserve model output order.
      const result = await this.api.executeRealtimeTool(
        this.conversationId,
        item.name,
        item.arguments,
      );
      const output = result.isOk()
        ? JSON.stringify(result.value)
        : JSON.stringify({ error: result.error.message });
      this.dataChannel?.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: item.call_id, output },
        }),
      );
      this.dataChannel?.send(JSON.stringify({ type: "response.create" }));
    }
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
          socket.addEventListener("error", () => reject(new Error("Control connection failed.")), {
            once: true,
          });
        });
        return socket;
      },
      catch: (cause) =>
        conversationClientError(
          "control_connection_failed",
          "Could not connect conversation control.",
          cause,
        ),
    });
    if (!connected.isOk()) return Result.err(connected.error);
    connected.value.addEventListener("message", (event) => this.handleControlMessage(event));
    return this.sendControl([
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
      return;
    }
    if (next.state === ConversationStateTag.Ending && this.recordingUpload !== null) {
      void this.finalizeRecording();
    }
  }

  private sendControl(message: BrowserWireMessage): Result<void, ConversationClientError> {
    if (this.control?.readyState !== WebSocket.OPEN) {
      return Result.err(
        new ConversationClientError("control_connection_closed", "Conversation control is closed."),
      );
    }
    const encoded = encodeWireMessage(message);
    if (!encoded.isOk()) {
      return Result.err(
        new ConversationClientError(
          "wire_protocol_error",
          "The control message could not be encoded.",
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
          "The control message could not be sent.",
          cause,
        ),
    });
  }
}

function waitForDataChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.addEventListener("open", () => resolve(), { once: true });
    channel.addEventListener("error", () => reject(new Error("Realtime data channel failed.")), {
      once: true,
    });
  });
}

function supportedRecordingType(): string {
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

interface FunctionCallItem {
  readonly type: "function_call";
  readonly name: string;
  readonly call_id: string;
  readonly arguments: string;
}

function isResponseDone(value: unknown): value is { response: { output: FunctionCallItem[] } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "response.done" &&
    "response" in value &&
    typeof value.response === "object" &&
    value.response !== null &&
    "output" in value.response &&
    Array.isArray(value.response.output)
  );
}

function isTerminal(state: ConversationStateDto["state"]): boolean {
  return (
    state === ConversationStateTag.Completed ||
    state === ConversationStateTag.Cancelled ||
    state === ConversationStateTag.Failed
  );
}
