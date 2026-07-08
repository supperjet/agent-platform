import type { Message } from "@earendil-works/pi-ai";

/** Converts runtime text controls into the provider-neutral user-message shape. */
export function createUserMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now()
  };
}
