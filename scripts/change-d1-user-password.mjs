import { Result } from "better-result";
import {
  executeD1,
  firstStatementRows,
  hashPassword,
  parseUserArguments,
  quoteSql,
  readPassword,
} from "./auth-user-utils.mjs";

const usage = "Usage: pnpm auth:change-password -- [--local|--remote] [database-name] <username>";

const result = await Result.tryPromise({
  try: async () => {
    const argumentsResult = parseUserArguments(process.argv.slice(2));
    if (!argumentsResult.isOk()) return Promise.reject(argumentsResult.error);
    const { database, location, username } = argumentsResult.value;
    const passwordResult = await hashPassword(await readPassword("New password: "));
    if (!passwordResult.isOk()) return Promise.reject(passwordResult.error);
    const quotedUsername = quoteSql(username);
    const sql = [
      `UPDATE users SET password_hash = ${quoteSql(passwordResult.value)} WHERE username = ${quotedUsername} COLLATE NOCASE RETURNING id, username`,
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ${quotedUsername} COLLATE NOCASE)`,
    ].join("; ");
    const execution = await executeD1({ database, location, sql, json: true });
    if (!execution.isOk()) return Promise.reject(execution.error);
    const updatedUsers = firstStatementRows(execution.value);
    if (updatedUsers === null)
      return Promise.reject(new Error("Wrangler returned an unexpected D1 response."));
    if (updatedUsers.length !== 1)
      return Promise.reject(new Error(`User '${username}' was not found.`));
    console.log(`Password changed and existing sessions revoked for '${username}'.`);
  },
  catch: (error) => error,
});
if (result.isErr()) {
  const error = result.error;
  if (error instanceof Error && error.message === "invalid user command arguments") {
    console.error(usage);
  } else {
    console.error(error instanceof Error ? error.message : "Could not change the user's password.");
  }
  process.exitCode = 1;
}
