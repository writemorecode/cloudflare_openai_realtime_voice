import { Result } from "better-result";
import {
  executeD1,
  hashPassword,
  parseUserArguments,
  quoteSql,
  readPassword,
} from "./auth-user-utils.mjs";

const usage = "Usage: pnpm auth:create-user -- [--local|--remote] [database-name] <username>";

const result = await Result.tryPromise({
  try: async () => {
    const argumentsResult = parseUserArguments(process.argv.slice(2));
    if (!argumentsResult.isOk()) return Promise.reject(argumentsResult.error);
    const { database, location, username } = argumentsResult.value;
    const passwordResult = await hashPassword(await readPassword());
    if (!passwordResult.isOk()) return Promise.reject(passwordResult.error);
    const sql = `INSERT INTO users (username, password_hash, created_at) VALUES (${quoteSql(username)}, ${quoteSql(passwordResult.value)}, ${Date.now()});`;
    const execution = await executeD1({ database, location, sql });
    if (!execution.isOk()) return Promise.reject(execution.error);
  },
  catch: (error) => error,
});
if (result.isErr()) {
  const error = result.error;
  if (error instanceof Error && error.message === "invalid user command arguments") {
    console.error(usage);
  } else {
    console.error(error instanceof Error ? error.message : "Could not create the D1 user.");
  }
  process.exitCode = 1;
}
