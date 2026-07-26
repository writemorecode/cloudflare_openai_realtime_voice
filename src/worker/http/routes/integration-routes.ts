import { ok } from "@ai-oral-exam/result";

import { handleAgentEvent } from "../../integrations/livekit/agent-events";
import { handleLiveKitWebhook } from "../../integrations/livekit/webhook";
import { toConversationStateDto } from "../conversation-state-dto";
import {
  apiFactory,
  methodNotAllowed,
  namedRoute,
  preflight,
  respond,
  validateSmallHeaders,
} from "../hono-api";

export function createIntegrationRoutes() {
  const app = apiFactory.createApp();

  app.options("/livekit/webhook", namedRoute("livekit_webhook"), ...preflight(["POST"]));
  app.post("/livekit/webhook", namedRoute("livekit_webhook"), async (context) => {
    const handled = await handleLiveKitWebhook(
      context.req.raw,
      context.env,
      context.get("dependencies"),
    );
    return respond(
      context,
      handled.ok
        ? ok({
            response: new Response(null, { status: 204 }),
            conversationId: handled.value.conversationId,
            state: toConversationStateDto(handled.value.state),
            outcome: handled.value.outcome,
          })
        : handled,
    );
  });
  app.all("/livekit/webhook", namedRoute("livekit_webhook"), ...methodNotAllowed(["POST"]));

  app.use("/livekit/agent-events", validateSmallHeaders);
  app.options("/livekit/agent-events", namedRoute("livekit_agent_event"), ...preflight(["POST"]));
  app.post("/livekit/agent-events", namedRoute("livekit_agent_event"), async (context) => {
    const handled = await handleAgentEvent(
      context.req.raw,
      context.env,
      context.get("dependencies"),
    );
    return respond(
      context,
      handled.ok
        ? ok({
            response: new Response(null, { status: 204 }),
            conversationId: handled.value.conversationId,
            state: toConversationStateDto(handled.value.state),
            outcome: handled.value.outcome,
          })
        : handled,
    );
  });
  app.all(
    "/livekit/agent-events",
    namedRoute("livekit_agent_event"),
    ...methodNotAllowed(["POST"]),
  );

  return app;
}
