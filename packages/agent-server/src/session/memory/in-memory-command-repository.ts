import { CommandRepository, type CommandRecord } from "../contracts.js";

export class InMemoryCommandRepository extends CommandRepository {
  private readonly commands = new Map<string, CommandRecord>();

  createIfAbsent(command: CommandRecord) {
    const existing = this.commands.get(command.commandId);
    if (existing) {
      return Promise.resolve({ created: false as const, command: { ...existing } });
    }
    const created = { ...command };
    this.commands.set(command.commandId, created);
    return Promise.resolve({ created: true as const, command: { ...created } });
  }

  save(command: CommandRecord) {
    this.commands.set(command.commandId, { ...command });
    return Promise.resolve();
  }

  find(commandId: string) {
    const command = this.commands.get(commandId);
    return Promise.resolve(command ? { ...command } : undefined);
  }
}
