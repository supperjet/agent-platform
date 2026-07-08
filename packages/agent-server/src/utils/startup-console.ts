import { styleText } from "node:util";

export function logStartupSuccess(message: string) {
  console.log(`${styleText(["bold", "green"], "✔")} ${styleText("green", message)}`);
}

export function logStartupWarning(message: string) {
  console.log(`${styleText(["bold", "yellow"], "◆")} ${styleText("yellow", message)}`);
}

export function logServerListening(message: string) {
  console.log(`${styleText(["bold", "cyan"], "➜")} ${styleText(["bold", "cyan"], message)}`);
}
