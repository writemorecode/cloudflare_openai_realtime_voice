import {
  executeD1,
  hashPassword,
  parseUserArguments,
  quoteSql,
  readPassword,
} from "./auth-user-utils.mjs";

const usage = "Usage: pnpm auth:create-user -- [--local|--remote] [database-name] <username>";

try {
  const { database, location, username } = parseUserArguments(process.argv.slice(2));
  const passwordHash = await hashPassword(await readPassword());
  const sql = `INSERT INTO users (username, password_hash, created_at) VALUES (${quoteSql(username)}, ${quoteSql(passwordHash)}, ${Date.now()});`;
  await executeD1({ database, location, sql });
} catch (error) {
  if (error instanceof Error && error.message === "invalid user command arguments") {
    console.error(usage);
  } else {
    console.error(error instanceof Error ? error.message : "Could not create the D1 user.");
  }
  process.exitCode = 1;
}
