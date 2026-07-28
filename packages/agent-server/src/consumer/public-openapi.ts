export function publicOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Agent Platform Session API", version: "1.0.0" },
    paths: {
      "/api/v1/sessions/{sessionId}/commands": { post: {
        summary: "Submit a session command",
        parameters: [sessionIdParameter()],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Command" } } } },
        responses: {
          "202": jsonResponse("Command accepted", "CommandReceipt"),
          "400": errorResponse(),
          "404": errorResponse(),
          "409": errorResponse()
        }
      } },
      "/api/v1/sessions/{sessionId}": { get: {
        summary: "Read session state",
        parameters: [sessionIdParameter()],
        responses: { "200": jsonResponse("Session summary", "Session"), "404": errorResponse() }
      } },
      "/api/v1/sessions/{sessionId}/events": { get: {
        summary: "Read session event history",
        parameters: [sessionIdParameter()],
        responses: { "200": jsonResponse("Event history", "EventHistory") }
      } },
      "/api/v1/sessions/{sessionId}/event-stream": { get: {
        summary: "Stream session events with SSE",
        parameters: [sessionIdParameter()],
        responses: { "200": { description: "SSE stream", content: { "text/event-stream": {} } } }
      } }
    },
    components: {
      schemas: {
        Command: {
          type: "object", additionalProperties: false, required: ["commandId", "type"],
          properties: {
            commandId: { type: "string", minLength: 1 },
            type: { type: "string", enum: ["prompt", "steer", "follow-up", "abort"] },
            text: { type: "string", minLength: 1 }
          }
        },
        CommandReceipt: {
          type: "object", required: ["accepted", "sessionId", "commandId", "type"],
          properties: {
            accepted: { const: true }, sessionId: { type: "string" }, commandId: { type: "string" },
            type: { type: "string", enum: ["prompt", "steer", "follow-up", "abort"] }
          }
        },
        Session: {
          type: "object", required: ["sessionId", "status", "createdAt", "lastActiveAt", "messageCount", "modelId"],
          properties: {
            sessionId: { type: "string" }, status: { type: "string", enum: ["idle", "running", "failed", "commit_failed", "closed"] },
            createdAt: { type: "string", format: "date-time" }, lastActiveAt: { type: "string", format: "date-time" },
            messageCount: { type: "integer", minimum: 0 }, modelId: { type: "string" }
          }
        },
        PublicEvent: {
          type: "object",
          required: ["eventId", "sequence", "sessionId", "commandId", "type", "occurredAt", "payload"],
          properties: {
            eventId: { type: "string" }, sequence: { type: "integer", minimum: 1 }, sessionId: { type: "string" },
            commandId: { type: "string" }, type: { type: "string" }, occurredAt: { type: "string", format: "date-time" },
            payload: { type: "object" }
          }
        },
        EventHistory: {
          type: "object", required: ["sessionId", "events"],
          properties: { sessionId: { type: "string" }, events: { type: "array", items: { $ref: "#/components/schemas/PublicEvent" } } }
        },
        Error: {
          type: "object", required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } }
        }
      }
    }
  };
}

function sessionIdParameter() {
  return { name: "sessionId", in: "path", required: true, schema: { type: "string" } };
}

function jsonResponse(description: string, schema: string) {
  return { description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } };
}

function errorResponse() {
  return jsonResponse("Request error", "Error");
}
