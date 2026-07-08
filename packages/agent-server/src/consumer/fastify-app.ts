import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { SessionApplication } from "../session/contracts.js";
import { CommandConflictError, InvalidCommandError } from "../session/errors.js";
import type { PublicEventStream } from "./public-event-stream.js";
import type {
  PublicCommand,
  PublicCommandReceipt,
  PublicEventHistory,
  PublicSession,
  PublicAgentEvent
} from "./contracts.js";
import { publicOpenApiDocument } from "./public-openapi.js";
import { publicError, toPublicHttpError } from "../utils/http-errors.js";
import { serializePublicEvent, serializeSse, sseHeaders, startHeartbeat } from "../utils/sse.js";

type SessionParams = { sessionId: string };

export type FastifyAgentDependencies = {
  application: SessionApplication; // 会话应用
  publicEvents: PublicEventStream;
};

const publicCommandBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "type"],
  properties: {
    commandId: { type: "string", minLength: 1 },
    type: { enum: ["prompt", "steer", "follow-up", "abort"] },
    text: { type: "string", minLength: 1 }
  }
} as const;

export function createAgentFastifyServer(
  dependencies: FastifyAgentDependencies,
  options: FastifyServerOptions = { logger: false }
): FastifyInstance {
  const app = Fastify(options);
  const publicEvents = dependencies.publicEvents;
  app.addHook("onClose", async () => {
    await dependencies.application.close();
    publicEvents.close();
  });

  app.post<{ Params: SessionParams; Body: PublicCommand }>(
    "/api/v1/sessions/:sessionId/commands",
    { schema: { body: publicCommandBodySchema } },
    async (request, reply) => {
      const { commandId, type, text } = request.body;
      const receipt = await dependencies.application.submitCommand({
        sessionId: request.params.sessionId,
        commandId,
        type,
        ...(text === undefined ? {} : { text })
      });
      if (!receipt.accepted) {
        return reply.code(404).send(publicError(
          "SESSION_NOT_FOUND",
          `Session "${request.params.sessionId}" was not found.`
        ));
      }
      const response: PublicCommandReceipt = {
        accepted: true,
        sessionId: receipt.sessionId,
        commandId,
        type
      };
      return reply.code(202).send(response);
    }
  );

  app.get<{ Params: SessionParams }>("/api/v1/sessions/:sessionId/events", async (request) => {
    const response: PublicEventHistory = {
      sessionId: request.params.sessionId,
      events: publicEvents.read(request.params.sessionId)
    };
    return response;
  });

  app.get<{ Params: SessionParams }>("/api/v1/sessions/:sessionId", async (request, reply) => {
    const session = await dependencies.application.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send(publicError(
        "SESSION_NOT_FOUND",
        `Session "${request.params.sessionId}" was not found.`
      ));
    }
    const response: PublicSession = session;
    return response;
  });

  app.get<{ Params: SessionParams }>("/api/v1/sessions/:sessionId/event-stream", async (request, reply) => {
    const { sessionId } = request.params;
    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    reply.raw.write(serializeSse("connected", { sessionId }));
    const unsubscribe = publicEvents.subscribe(sessionId, (event: PublicAgentEvent) => {
      if (!reply.raw.destroyed) reply.raw.write(serializePublicEvent(event));
    });
    const heartbeat = startHeartbeat(reply.raw);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  app.get("/api/v1/openapi.json", async () => publicOpenApiDocument());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CommandConflictError) {
      return reply.code(409).send(publicError(error.code, error.message));
    }
    if (error instanceof InvalidCommandError) {
      return reply.code(400).send(publicError(error.code, error.message));
    }
    const response = toPublicHttpError(error);
    return reply.code(response.statusCode).send(response.body);
  });

  return app;
}
