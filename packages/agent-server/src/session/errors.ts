export class InvalidCommandError extends Error {
  readonly code = "INVALID_COMMAND";
}

export class CommandConflictError extends Error {
  readonly code = "COMMAND_CONFLICT";
}
