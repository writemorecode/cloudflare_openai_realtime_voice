/** Renders authentication, examination management, live sessions, and recording history. */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ConversationStateTag,
  HttpConversationApi,
  TransportStatus,
  createConversationRuntime,
  type CreateExaminationRequest,
  type ConversationApi,
  type ConversationRuntime,
  type ConversationStateDto,
  type ExaminationSession,
  type ExaminationSummary,
  type RuntimeFactory,
} from "@ai-oral-exam/conversation-client";

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
    void api
      .getSession()
      .then(
        (result) => !disposed && setAuthState(result.isOk() ? "authenticated" : "unauthenticated"),
      );
    return () => {
      disposed = true;
    };
  }, [api, services]);

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
    return <LoginPage api={api} onAuthenticated={() => setAuthState("authenticated")} />;
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
  return (
    <DashboardPage api={api} navigate={navigate} onLogout={() => setAuthState("unauthenticated")} />
  );
}

export function LoginPage({
  api,
  onAuthenticated,
}: {
  readonly api: ConversationApi;
  readonly onAuthenticated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const signIn = async () => {
    if (username.length === 0 || password.length === 0) {
      setError("Enter your username and password to continue.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const authenticated = await api.login(username, password);
    if (!authenticated.isOk()) {
      setError(messageFor(authenticated.error));
      setSubmitting(false);
      return;
    }
    onAuthenticated();
  };

  return (
    <PageFrame>
      <main className="card home-card">
        <p className="eyebrow">Oral exam</p>
        <h1>Examinations that listen closely.</h1>
        <p className="lead">
          Create and take structured oral examinations with an AI examiner. Every grade remains a
          human decision.
        </p>
        <form
          className="start-form"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
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
              disabled={submitting}
            />
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={submitting}
              aria-label="Password"
            />
          </div>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </PageFrame>
  );
}

export function DashboardPage({
  api,
  navigate,
  onLogout,
}: PageProps & {
  readonly api: ConversationApi;
  readonly onLogout: () => void;
}) {
  const [examinations, setExaminations] = useState<ExaminationSummary[]>([]);
  const [sessions, setSessions] = useState<ExaminationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [examResult, sessionResult] = await Promise.all([
      api.listExaminations(),
      api.listExaminationSessions(),
    ]);
    if (!examResult.isOk()) {
      setError(messageFor(examResult.error));
      setLoading(false);
      return;
    }
    if (!sessionResult.isOk()) {
      setError(messageFor(sessionResult.error));
      setLoading(false);
      return;
    }
    setExaminations(examResult.value.examinations);
    setSessions(sessionResult.value.sessions);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [api]);

  const create = async (request: CreateExaminationRequest) => {
    setCreating(true);
    setError(null);
    const result = await api.createExamination(request);
    if (!result.isOk()) {
      setError(messageFor(result.error));
      setCreating(false);
      return false;
    }
    setExaminations((current) => [result.value, ...current]);
    setCreating(false);
    return true;
  };

  const start = async (examinationId: string) => {
    setStartingId(examinationId);
    setError(null);
    const result = await api.createExaminationSession(examinationId);
    if (!result.isOk()) {
      setError(messageFor(result.error));
      setStartingId(null);
      return;
    }
    navigate(`/conversation/${result.value.conversationId}`);
  };

  const logout = async () => {
    const result = await api.logout();
    if (!result.isOk()) {
      setError(messageFor(result.error));
      return;
    }
    onLogout();
  };

  return (
    <PageFrame wide>
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Examiner workspace</p>
          <h1>Oral examinations</h1>
        </div>
        <button className="text-button" type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <main className="dashboard-grid">
        <section className="dashboard-main" aria-labelledby="available-heading">
          <CreateExaminationForm creating={creating} onCreate={create} />
          <div className="section-heading">
            <div>
              <p className="eyebrow">Available now</p>
              <h2 id="available-heading">Examinations</h2>
            </div>
            <span>{examinations.length}</span>
          </div>
          {loading ? (
            <p className="empty-state">Loading examinations…</p>
          ) : examinations.length === 0 ? (
            <p className="empty-state">Create the first examination to get started.</p>
          ) : (
            <div className="exam-list">
              {examinations.map((examination) => (
                <article className="exam-card" key={examination.id}>
                  <div>
                    <p className="subject-label">{examination.subject}</p>
                    <h3>{examination.name}</h3>
                    <p>
                      {examination.questionCount} question
                      {examination.questionCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    className="primary-button compact-button"
                    type="button"
                    disabled={startingId !== null}
                    onClick={() => void start(examination.id)}
                  >
                    {startingId === examination.id ? "Preparing…" : "Start exam"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        <aside className="history-panel" aria-labelledby="history-heading">
          <p className="eyebrow">Assessment record</p>
          <h2 id="history-heading">Previous sessions</h2>
          {loading ? (
            <p className="empty-state">Loading history…</p>
          ) : sessions.length === 0 ? (
            <p className="empty-state">Completed and active sessions will appear here.</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <article className="session-card" key={session.id}>
                  <div className="session-card-heading">
                    <div>
                      <h3>{session.examinationName}</h3>
                      <p>{new Date(session.createdAt).toLocaleString()}</p>
                    </div>
                    <span>{session.conversationState ?? "unknown"}</span>
                  </div>
                  <p className="session-progress">
                    Questions: {session.currentQuestionOrdinal}/{session.questionCount}
                  </p>
                  {session.recordingAvailable ? (
                    <audio
                      className="recording-player"
                      controls
                      preload="metadata"
                      src={api.recordingUrl(session.id)}
                    >
                      Your browser does not support audio playback.
                    </audio>
                  ) : (
                    <p className="recording-pending">Recording not yet available</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </aside>
      </main>
    </PageFrame>
  );
}

function CreateExaminationForm({
  creating,
  onCreate,
}: {
  readonly creating: boolean;
  readonly onCreate: (request: CreateExaminationRequest) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [questions, setQuestions] = useState([""]);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const normalizedQuestions = questions.map((question) => question.trim());
    if (name.trim() === "" || subject.trim() === "" || normalizedQuestions.some((q) => q === "")) {
      setError("Add a name, subject, and text for every question.");
      return;
    }
    setError(null);
    const created = await onCreate({
      name: name.trim(),
      subject: subject.trim(),
      questions: normalizedQuestions,
    });
    if (created) {
      setName("");
      setSubject("");
      setQuestions([""]);
    }
  };

  return (
    <details className="create-panel">
      <summary>Create an examination</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field-row">
          <label>
            Examination name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              disabled={creating}
            />
          </label>
          <label>
            Subject
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={160}
              disabled={creating}
            />
          </label>
        </div>
        <fieldset>
          <legend>Questions, in order</legend>
          {questions.map((question, index) => (
            <div className="question-row" key={index}>
              <span>{index + 1}</span>
              <textarea
                aria-label={`Question ${index + 1}`}
                value={question}
                onChange={(event) =>
                  setQuestions((current) =>
                    current.map((value, currentIndex) =>
                      currentIndex === index ? event.target.value : value,
                    ),
                  )
                }
                maxLength={4000}
                rows={2}
                disabled={creating}
              />
              {questions.length > 1 && (
                <button
                  className="remove-question"
                  type="button"
                  aria-label={`Remove question ${index + 1}`}
                  onClick={() =>
                    setQuestions((current) =>
                      current.filter((_value, currentIndex) => currentIndex !== index),
                    )
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </fieldset>
        <div className="form-actions">
          <button
            className="text-button"
            type="button"
            onClick={() => setQuestions((current) => [...current, ""])}
            disabled={creating || questions.length >= 100}
          >
            + Add question
          </button>
          <button className="primary-button compact-button" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create examination"}
          </button>
        </div>
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </form>
    </details>
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
      const current = await api.getState(conversationId);
      if (!current.isOk()) {
        if (!disposed) setError(messageFor(current.error));
        return;
      }
      const started =
        current.value.state === ConversationStateTag.Created
          ? await api.startConversation(conversationId)
          : current;
      if (!started.isOk()) {
        if (!disposed) setError(messageFor(started.error));
        return;
      }
      if (disposed || audioHost.current === null) return;
      setState(started.value);
      setPhase(labelForState(started.value));
      const connected = await instance.connect(started.value, audioHost.current);
      if (!connected.isOk() && !disposed) setError(messageFor(connected.error));
    };
    void connect();
    return () => {
      disposed = true;
      void instance.close();
    };
  }, [api, conversationId, navigate, runtimeFactory]);

  const toggleMute = async () => {
    if (runtime.current === null) return;
    const next = !muted;
    const changed = await runtime.current.setMicrophoneEnabled(!next);
    if (!changed.isOk()) {
      setError(messageFor(changed.error));
      return;
    }
    setMuted(next);
  };

  const end = async () => {
    if (runtime.current === null) return;
    setEnding(true);
    setError(null);
    const ended = await runtime.current.requestEnd();
    if (!ended.isOk()) {
      setError(messageFor(ended.error));
      setEnding(false);
      return;
    }
    navigate(`/conversation/${conversationId}/complete`);
  };

  const enableAudio = async () => {
    if (runtime.current === null) return;
    const enabled = await runtime.current.enableAudio();
    if (!enabled.isOk()) setError(messageFor(enabled.error));
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
          <button className="secondary-button" type="button" onClick={() => void enableAudio()}>
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
      const next = await api.getState(conversationId);
      if (!next.isOk()) {
        if (!disposed) setError(messageFor(next.error));
        return;
      }
      if (disposed) return;
      setState(next.value);
      if (!isTerminal(next.value.state)) timer = window.setTimeout(() => void refresh(), 1_500);
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
            ? "Examination complete"
            : failed
              ? "The examination ended early"
              : cancelled
                ? "Examination cancelled"
                : "Saving your examination"}
        </h1>
        <p className="lead">
          {completed
            ? "Your recording has been saved for review."
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
          Back to examinations
        </button>
      </main>
    </PageFrame>
  );
}

function PageFrame({
  children,
  compact = false,
  wide = false,
}: {
  readonly children: React.ReactNode;
  readonly compact?: boolean;
  readonly wide?: boolean;
}) {
  return (
    <div className={`page-shell ${compact ? "compact" : ""} ${wide ? "wide-shell" : ""}`}>
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
  if (state.state === ConversationStateTag.Ending) return "Finalizing recording";
  if (state.transport.status === TransportStatus.Reconnecting) return "Reconnecting";
  if (state.state === ConversationStateTag.Live) return "Live · Recording";
  if (state.transport.status === TransportStatus.Connected) {
    return "Connected · Starting recording";
  }
  return "Connecting";
}

function displayState(state: ConversationStateDto["state"]): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function isTerminal(state: ConversationStateDto["state"]): boolean {
  return (
    state === ConversationStateTag.Completed ||
    state === ConversationStateTag.Cancelled ||
    state === ConversationStateTag.Failed
  );
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong. Please try again.";
}
