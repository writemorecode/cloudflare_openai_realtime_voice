import { Result } from "better-result";

import { login, logout } from "../browser-auth";
import {
  apiFactory,
  currentUser,
  methodNotAllowed,
  namedRoute,
  preflight,
  requireBrowserOrigin,
  requireBrowserSession,
  requireEmptyBody,
  respond,
  validateSmallHeaders,
} from "../hono-api";

export function createAuthRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options("/login", namedRoute("login"), ...preflight(["POST"]));
  app.post("/login", namedRoute("login"), requireBrowserOrigin, async (context) => {
    const loggedIn = await login(context.req.raw, context.env.AUTH_DB);
    return respond(
      context,
      loggedIn.isOk()
        ? Result.ok({ response: loggedIn.value, conversationId: null, outcome: "logged_in" })
        : loggedIn,
    );
  });
  app.all("/login", namedRoute("login"), ...methodNotAllowed(["POST"]));

  app.options("/logout", namedRoute("logout"), ...preflight(["POST"]));
  app.post(
    "/logout",
    namedRoute("logout"),
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) => {
      const loggedOut = await logout(context.req.raw, context.env.AUTH_DB);
      return respond(
        context,
        loggedOut.isOk()
          ? Result.ok({ response: loggedOut.value, conversationId: null, outcome: "logged_out" })
          : loggedOut,
      );
    },
  );
  app.all("/logout", namedRoute("logout"), ...methodNotAllowed(["POST"]));

  app.options("/session", namedRoute("auth_session"), ...preflight(["GET"]));
  app.get(
    "/session",
    namedRoute("auth_session"),
    requireBrowserSession,
    requireEmptyBody,
    (context) =>
      respond(
        context,
        Result.ok({
          response: Response.json(
            { username: currentUser(context).username },
            { headers: { "Cache-Control": "no-store" } },
          ),
          conversationId: null,
          outcome: "session_returned",
        }),
      ),
  );
  app.all("/session", namedRoute("auth_session"), ...methodNotAllowed(["GET"]));

  return app;
}
