export default {
  overrides: [
    {
      // These are the deliberate public entry points for independently versioned packages.
      files: [
        "packages/conversation-client/src/index.ts",
        "packages/conversation-contract/src/index.ts",
      ],
      rules: {
        "structure.barrel-density": { enabled: false },
      },
    },
    {
      // ConversationSession is the typed Durable Object RPC facade. Its public methods must
      // delegate to internal stores rather than exposing those stores to Worker callers.
      files: ["src/durable-object/conversation-session.ts"],
      rules: {
        "structure.pass-through-wrappers": { enabled: false },
      },
    },
    {
      // These directories separate cohesive stateful and HTTP responsibilities; grouping the
      // files further would add nesting without reducing dependencies.
      files: ["src/durable-object/**", "src/worker/http/**"],
      rules: {
        "structure.directory-fanout-hotspot": { enabled: false },
      },
    },
    {
      // The reported calls occur in unrelated package, Queue, and UI tests. Sharing their
      // vi.fn().mockResolvedValue setup would couple otherwise independent test layers.
      files: ["packages/conversation-client/test/api.test.ts", "web/src/App.test.tsx"],
      rules: {
        "tests.duplicate-mock-setup": { enabled: false },
      },
    },
  ],
};
