import {
  executeD1,
  firstStatementRows,
  hashPassword,
  parseUserArguments,
  quoteSql,
  readPassword,
} from "./auth-user-utils.mjs";

const usage = "Usage: pnpm auth:change-password -- [--local|--remote] [database-name] <username>";

try {
  const { database, location, username } = parseUserArguments(process.argv.slice(2));
  const passwordHash = await hashPassword(await readPassword("New password: "));
  const quotedUsername = quoteSql(username);
  const sql = [
    `UPDATE users SET password_hash = ${quoteSql(passwordHash)} WHERE username = ${quotedUsername} COLLATE NOCASE RETURNING id, username`,
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ${quotedUsername} COLLATE NOCASE)`,
  ].join("; ");
  const output = await executeD1({ database, location, sql, json: true });
  const updatedUsers = firstStatementRows(output);
  if (updatedUsers === null) throw new Error("Wrangler returned an unexpected D1 response.");
  if (updatedUsers.length !== 1) throw new Error(`User '${username}' was not found.`);
  console.log(`Password changed and existing sessions revoked for '${username}'.`);
} catch (error) {
  if (error instanceof Error && error.message === "invalid user command arguments") {
    console.error(usage);
  } else {
    console.error(error instanceof Error ? error.message : "Could not change the user's password.");
  }
  process.exitCode = 1;
}
