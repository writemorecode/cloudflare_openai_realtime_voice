/** Executes the function tools requested by the OpenAI Realtime model. */
import { Result } from "better-result";

import {
  completeRealtimeCurrentQuestion,
  getRealtimeCurrentQuestion,
} from "../../examinations/examination-api";
import {
  apiFactory,
  conversationIdParam,
  currentUser,
  getConversationId,
  namedRoute,
  preflight,
  requireBrowserOrigin,
  requireBrowserSession,
  requireEmptyBody,
  respond,
  validateSmallHeaders,
} from "../hono-api";

export function createRealtimeToolRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options(
    "/:conversationId/tools/get_current_examination_question",
    namedRoute("realtime_tool"),
    ...preflight(["POST"]),
  );
  app.post(
    "/:conversationId/tools/get_current_examination_question",
    namedRoute("realtime_tool"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) => {
      const conversationId = getConversationId(context);
      if (!conversationId.isOk()) return respond(context, Result.err(conversationId.error));
      const user = currentUser(context);
      return user.isOk()
        ? respond(
            context,
            await getRealtimeCurrentQuestion(conversationId.value, user.value, context.env),
          )
        : respond(context, Result.err(user.error));
    },
  );

  app.options(
    "/:conversationId/tools/complete_current_examination_question",
    namedRoute("realtime_tool"),
    ...preflight(["POST"]),
  );
  app.post(
    "/:conversationId/tools/complete_current_examination_question",
    namedRoute("realtime_tool"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    async (context) => {
      const conversationId = getConversationId(context);
      if (!conversationId.isOk()) return respond(context, Result.err(conversationId.error));
      const user = currentUser(context);
      return user.isOk()
        ? respond(
            context,
            await completeRealtimeCurrentQuestion(
              context.req.raw,
              conversationId.value,
              user.value,
              context.env,
              context.get("dependencies"),
            ),
          )
        : respond(context, Result.err(user.error));
    },
  );

  return app;
}
