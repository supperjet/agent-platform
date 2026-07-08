export function publicError(code: string, message: string) {
  return { error: { code, message } };
}

export function toPublicHttpError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown request error.";
  const statusCode = readErrorStatusCode(error) ?? (message.includes("already processing") ? 409 : 500);
  const code = statusCode === 400
    ? "INVALID_REQUEST"
    : statusCode === 409
      ? "SESSION_BUSY"
      : "INTERNAL_ERROR";
  return {
    statusCode,
    body: publicError(code, statusCode >= 500 ? "Agent request failed." : message)
  };
}

function readErrorStatusCode(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
