import { useEffect, useMemo, useRef, useState } from "react";

import { ConversationStateTag, TransportStatus } from "../../src/domain/conversation-state-machine";
import type { ConversationStateDto } from "../../src/worker/http/conversation-state-dto";
import { HttpConversationApi } from "./api";
import { createConversationRuntime } from "./runtime";
import type { ConversationApi, ConversationRuntime, RuntimeFactory } from "./types";

interface Services {
  readonly api: ConversationApi;
  readonly runtimeFactory: RuntimeFactory;
}

interface PageProps {
  readonly navigate: (path: string) => void;
}

export function App({ services }: { readonly services?: Services }) {
  const api = useMemo(() => services?.api ?? new HttpConversationApi(), [services]);
  const [authState, setAuthState] = useState<"loading" | "authenticated" | "unauthenticated">(
    services === undefined ? "loading" : "authenticated",
  );
  const runtimeFactory = services?.runtimeFactory ?? createConversationRuntime;
  const [path, setPath] = useState(window.location.pathname);
  const navigate = (next: string) => {
    window.history.pushState(null, "", next);
    setPath(next);
  };

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (services !== undefined) return;
    let disposed = false;
    void api.getSession().then(
      () => !disposed && setAuthState("authenticated"),
      () => !disposed && setAuthState("unauthenticated"),
    );
    return () => {
      disposed = true;
    };
  }, [api, services]);

  const authenticateAndCreate = async (
    username: string,
    password: string,
  ): Promise<ConversationStateDto> => {
    await api.login(username, password);
    const created = await api.createConversation();
    setAuthState("authenticated");
    return created;
  };

  if (authState === "loading") {
    return (
      <PageFrame>
        <main className="card home-card" aria-live="polite">
          <p className="lead">Checking your session…</p>
        </main>
      </PageFrame>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <HomePage api={null} authenticateAndCreate={authenticateAndCreate} navigate={navigate} />
    );
  }

  const postMatch = /^\/conversation\/([^/]+)\/complete$/.exec(path);
  if (postMatch?.[1]) {
    return <PostConversationPage conversationId={postMatch[1]} api={api} navigate={navigate} />;
  }
  const conversationMatch = /^\/conversation\/([^/]+)$/.exec(path);
  if (conversationMatch?.[1]) {
    return (
      <ConversationPage
        conversationId={conversationMatch[1]}
        api={api}
        runtimeFactory={runtimeFactory}
        navigate={navigate}
      />
    );
  }
  return <HomePage api={api} navigate={navigate} />;
}

export function HomePage({
  api,
  authenticateAndCreate,
  navigate,
}: PageProps & {
  readonly api: ConversationApi | null;
  readonly authenticateAndCreate?: (
    username: string,
    password: string,
  ) => Promise<ConversationStateDto>;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const start = async () => {
    if (api === null && (username.length === 0 || password.length === 0)) {
      setError("Enter your username and password to continue.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const created =
        api === null
          ? await requireAuthenticate(authenticateAndCreate)(username, password)
          : await api.createConversation();
      navigate(`/conversation/${created.conversationId}`);
    } catch (cause) {
      setError(messageFor(cause));
      setStarting(false);
    }
  };

  return (
    <PageFrame>
      <main className="card home-card">
        <p className="eyebrow">Oral exam</p>
        <h1>A quiet space to talk through what you know.</h1>
        <p className="lead">
          You’ll speak with an AI examiner. Your microphone will be used during the conversation,
          and the session will be recorded for review.
        </p>
        <div className="note" aria-label="Before you begin">
          <span className="note-icon" aria-hidden="true">
            i
          </span>
          <p>Find a calm place and allow microphone access when your browser asks.</p>
        </div>
        <form
          className="start-form"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          {api === null && (
            <div className="temporary-auth">
              <div className="temporary-auth-heading">
                <label htmlFor="username">Sign in</label>
              </div>
              <input
                id="username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={starting}
              />
              <input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={starting}
                aria-label="Password"
              />
            </div>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <button className="primary-button" type="submit" disabled={starting}>
            {starting ? "Preparing…" : "Start conversation"}
          </button>
        </form>
        <p className="fine-print">You can end the conversation at any time.</p>
      </main>
    </PageFrame>
  );
}

export function ConversationPage({
  conversationId,
  api,
  runtimeFactory,
  navigate,
}: PageProps & {
  readonly conversationId: string;
  readonly api: ConversationApi;
  readonly runtimeFactory: RuntimeFactory;
}) {
  const audioHost = useRef<HTMLDivElement>(null);
  const runtime = useRef<ConversationRuntime | null>(null);
  const [state, setState] = useState<ConversationStateDto | null>(null);
  const [phase, setPhase] = useState("Preparing your conversation…");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [ending, setEnding] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  useEffect(() => {
    let disposed = false;
    const instance = runtimeFactory(api, conversationId, {
      onState: (next) => {
        if (disposed) return;
        setState(next);
        setPhase(labelForState(next));
        if (isTerminal(next.state)) navigate(`/conversation/${conversationId}/complete`);
      },
      onPlaybackBlocked: (blocked) => !disposed && setPlaybackBlocked(blocked),
    });
    runtime.current = instance;

    const connect = async () => {
      try {
        const current = await api.getState(conversationId);
        const started =
          current.state === ConversationStateTag.Created
            ? await api.startConversation(conversationId)
            : current;
        if (disposed || audioHost.current === null) return;
        setState(started);
        setPhase(labelForState(started));
        await instance.connect(started, audioHost.current);
      } catch (cause) {
        if (!disposed) setError(messageFor(cause));
      }
    };
    void connect();
    return () => {
      disposed = true;
      void instance.close();
    };
  }, [api, conversationId, navigate, runtimeFactory]);

  const toggleMute = async () => {
    try {
      const next = !muted;
      await runtime.current?.setMicrophoneEnabled(!next);
      setMuted(next);
    } catch (cause) {
      setError(messageFor(cause));
    }
  };

  const end = async () => {
    if (runtime.current === null) return;
    setEnding(true);
    setError(null);
    try {
      await runtime.current.requestEnd();
      navigate(`/conversation/${conversationId}/complete`);
    } catch (cause) {
      setError(messageFor(cause));
      setEnding(false);
    }
  };

  const readyToEnd =
    state !== null && "epoch" in state.transport && state.transport.epoch > 0 && !ending;

  return (
    <PageFrame compact>
      <main className="card conversation-card">
        <div className="status-pill">
          <span className="status-dot" />
          {phase}
        </div>
        <div className="voice-orb" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="conversation-copy">
          <h1>{ending ? "Finishing up" : "Conversation in progress"}</h1>
          <p>
            {ending
              ? "Please wait while the recording is secured."
              : "Speak naturally. The examiner is listening."}
          </p>
        </div>
        {state?.transport.status === TransportStatus.Reconnecting && (
          <p className="inline-status">Connection interrupted. Reconnecting…</p>
        )}
        {playbackBlocked && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void runtime.current?.enableAudio()}
          >
            Enable examiner audio
          </button>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <div className="controls">
          <button
            className="round-button"
            type="button"
            onClick={() => void toggleMute()}
            aria-pressed={muted}
          >
            <MicrophoneIcon muted={muted} />
            <span>{muted ? "Unmute" : "Mute"}</span>
          </button>
          <button
            className="end-button"
            type="button"
            onClick={() => void end()}
            disabled={!readyToEnd}
          >
            <PhoneIcon />
            <span>{ending ? "Ending…" : "End"}</span>
          </button>
        </div>
        <div ref={audioHost} className="audio-host" aria-hidden="true" />
      </main>
    </PageFrame>
  );
}

export function PostConversationPage({
  conversationId,
  api,
  navigate,
}: PageProps & { readonly conversationId: string; readonly api: ConversationApi }) {
  const [state, setState] = useState<ConversationStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const refresh = async () => {
      try {
        const next = await api.getState(conversationId);
        if (disposed) return;
        setState(next);
        if (!isTerminal(next.state)) timer = window.setTimeout(() => void refresh(), 1_500);
      } catch (cause) {
        if (!disposed) setError(messageFor(cause));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, conversationId]);

  const completed = state?.state === ConversationStateTag.Completed;
  const failed = state?.state === ConversationStateTag.Failed;
  const cancelled = state?.state === ConversationStateTag.Cancelled;
  const final = completed || failed || cancelled;

  return (
    <PageFrame>
      <main className="card post-card">
        <div
          className={`result-mark ${completed ? "success" : final ? "neutral" : "working"}`}
          aria-hidden="true"
        >
          {completed ? "✓" : final ? "–" : "…"}
        </div>
        <p className="eyebrow">Session summary</p>
        <h1>
          {completed
            ? "Conversation complete"
            : failed
              ? "The conversation ended early"
              : cancelled
                ? "Conversation cancelled"
                : "Saving your conversation"}
        </h1>
        <p className="lead">
          {completed
            ? "Your recording has been saved and is ready for the next step."
            : failed
              ? "We couldn’t finish the session normally. No action is needed right now."
              : cancelled
                ? "The session ended before the conversation began."
                : "The call has ended. We’re securely finalizing the recording now."}
        </p>
        <div className="summary-row">
          <span>Status</span>
          <strong>{state ? displayState(state.state) : "Checking…"}</strong>
        </div>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button className="secondary-button wide" type="button" onClick={() => navigate("/")}>
          Back to home
        </button>
      </main>
    </PageFrame>
  );
}

function PageFrame({
  children,
  compact = false,
}: {
  readonly children: React.ReactNode;
  readonly compact?: boolean;
}) {
  return (
    <div className={`page-shell ${compact ? "compact" : ""}`}>
      <div className="brand">
        Oral<span>·</span>Exam
      </div>
      {children}
      <footer>Private · Secure · Recorded with consent</footer>
    </div>
  );
}

function ErrorMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="error-message" role="alert">
      {children}
    </p>
  );
}

function MicrophoneIcon({ muted }: { readonly muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="none" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
      {muted && <path d="M4 4l16 16" />}
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.6 10.8c3.5-1.7 7.3-1.7 10.8 0l1.4-2.4c.4-.7.1-1.6-.6-2-4-2-8.4-2-12.4 0-.7.4-1 1.3-.6 2z" />
    </svg>
  );
}

function labelForState(state: ConversationStateDto): string {
  if (state.state === ConversationStateTag.Live) return "Live · Recording";
  if (state.state === ConversationStateTag.Ending) return "Finalizing recording";
  if (state.transport.status === TransportStatus.Reconnecting) return "Reconnecting";
  return "Connecting";
}

function displayState(state: ConversationStateTag): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function isTerminal(state: ConversationStateTag): boolean {
  return (
    state === ConversationStateTag.Completed ||
    state === ConversationStateTag.Cancelled ||
    state === ConversationStateTag.Failed
  );
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong. Please try again.";
}

function requireAuthenticate(
  authenticateAndCreate:
    | ((username: string, password: string) => Promise<ConversationStateDto>)
    | undefined,
): (username: string, password: string) => Promise<ConversationStateDto> {
  if (authenticateAndCreate === undefined) {
    throw new Error("Authentication is unavailable.");
  }
  return authenticateAndCreate;
}
