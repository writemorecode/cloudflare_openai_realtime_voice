import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import test from "node:test";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const IMPORT_PATTERN = /(?:from\s+|import\s*\()(["'])([^"']+)\1/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

async function importsIn(directory) {
  const imports = await Promise.all(
    (await sourceFiles(directory)).map(async (file) => {
      const source = await readFile(file, "utf8");
      return [...source.matchAll(IMPORT_PATTERN)].map((match) => ({
        file,
        specifier: match[2],
      }));
    }),
  );
  return imports.flat();
}

test("the application depends on the foundation only through conversation-client", async () => {
  const violations = (await importsIn("web/src")).filter(
    ({ specifier }) =>
      specifier?.includes("/src/") ||
      specifier === "@ai-oral-exam/conversation-contract" ||
      (specifier?.startsWith("@ai-oral-exam/") &&
        specifier !== "@ai-oral-exam/conversation-client"),
  );

  assert.deepEqual(
    violations.map(({ file, specifier }) => `${relative(".", file)} -> ${specifier}`),
    [],
  );
});

test("the public contract has no application or runtime dependencies", async () => {
  const allowed = new Set(["@msgpack/msgpack", "zod"]);
  const violations = (await importsIn("packages/conversation-contract/src")).filter(
    ({ specifier }) =>
      specifier !== undefined && !specifier.startsWith(".") && !allowed.has(specifier),
  );

  assert.deepEqual(
    violations.map(({ file, specifier }) => `${relative(".", file)} -> ${specifier}`),
    [],
  );
});

test("foundation decision modules remain synchronous and effect-free", async () => {
  const decisionFiles = (await sourceFiles("src/worker/integrations/livekit")).filter((file) =>
    file.endsWith("-decisions.ts"),
  );
  assert.ok(decisionFiles.length > 0, "expected foundation decision modules");

  const forbiddenPatterns = [
    /from\s+["']cloudflare:workers["']/,
    /\/adapters\//,
    /\basync\s+function\b/,
    /\bPromise\s*</,
    /\bDate\.now\s*\(/,
    /\bcrypto\./,
    /\benv\./,
    /\.getState\s*\(/,
    /\.applyIntegrationEvent\s*\(/,
    /\.record(?:Agent|LiveKit)Observation\s*\(/,
    /\.head\s*\(/,
  ];
  const violations = (
    await Promise.all(
      decisionFiles.map(async (file) => {
        const source = await readFile(file, "utf8");
        return forbiddenPatterns
          .filter((pattern) => pattern.test(source))
          .map((pattern) => `${relative(".", file)} -> ${pattern.source}`);
      }),
    )
  ).flat();

  assert.deepEqual(violations, []);
});
