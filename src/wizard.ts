import { EasyOptions } from "./easy.js";
import { Capabilities, BranchName } from "./config.js";
import { z } from "zod";

export type Question = (message: string) => Promise<string>;
export type SetupValues = { baseBranch?: string; capabilities?: ("text" | "vision" | "audio")[]; mediaModel?: { model: string; capabilities: ("text" | "vision" | "audio")[] }; model?: string; trigger?: string; signature?: string; authors?: string[]; everySeconds?: number; check?: string[] | false; autoMerge?: { enabled: boolean; method: "merge" | "squash" | "rebase" } };
export async function configure(question: Question, defaults: { login: string; model?: string; check?: string[]; capabilities?: ("text" | "vision" | "audio")[] }, supplied: SetupValues = {}) {
  async function ask<T>(label: string, fallback: string | undefined, parse: (value: string) => T): Promise<T> {
    let error = "";
    for (;;) {
      const raw = (await question(`${error}${label}${fallback === undefined ? " (required)" : ` [${fallback}]`}: `)).trim();
      try { return parse(raw || fallback || ""); }
      catch { error = "Invalid value. Please try again.\n"; }
    }
  }
  const field = <K extends keyof typeof EasyOptions.shape>(key: K) => (value: string) => EasyOptions.shape[key].parse(value) as string;
  const model = supplied.model ?? await ask("OpenCode 2 model (provider/model)", defaults.model, field("model"));
  const capabilities = supplied.capabilities ?? await ask("Main model capabilities (comma-separated: text,vision,audio)", (defaults.capabilities ?? ["text"]).join(","), value => Capabilities.parse(value.split(",").map(s => s.trim())));
  let mediaModel = supplied.mediaModel;
  if (!capabilities.includes("vision") && !mediaModel) {
    const model = await ask("Vision helper model (provider/model)", undefined, field("model"));
    const helperCapabilities = await ask("Helper model capabilities", "text,vision", value => {
      const capabilities = Capabilities.parse(value.split(",").map(s => s.trim()));
      if (!capabilities.includes("vision")) throw new Error("Vision support is required");
      return capabilities;
    });
    mediaModel = { model, capabilities: helperCapabilities };
  }
  const baseBranch = supplied.baseBranch ?? await ask("Base branch (or 'default' for the repository default)", "default", value => value === "default" ? undefined : BranchName.parse(value));
  const trigger = supplied.trigger ?? await ask("Issue trigger", "@opencodebot", field("trigger"));
  const signature = supplied.signature ?? await ask("Message signature", `${defaults.login}[OpenCode2]`, field("signature"));
  const authors = supplied.authors ?? await ask("Allowed GitHub users (comma-separated)", defaults.login, value => EasyOptions.shape.authors.parse(value.split(",").map(s => s.trim()))!);
  const everySeconds = supplied.everySeconds ?? await ask("Polling interval in seconds", "60", value => EasyOptions.shape.everySeconds.parse(Number(value)));
  const enabled = supplied.autoMerge?.enabled ?? await ask("Merge after authorized approval (yes/no)", "yes", value => {
    if (!["yes", "no", "y", "n"].includes(value.toLowerCase())) throw new Error("Expected yes or no");
    return ["yes", "y"].includes(value.toLowerCase());
  });
  const method = supplied.autoMerge?.method ?? (enabled ? await ask("Merge method", "squash", value => z.enum(["merge", "squash", "rebase"]).parse(value)) : "squash");
  const check = supplied.check ?? await ask("Test command (or 'skip'; use a JSON argument array for complex commands)", defaults.check ? JSON.stringify(defaults.check) : "skip", value => {
    if (value.toLowerCase() === "skip") return false as const;
    if (value.startsWith("[")) return z.array(z.string().min(1)).min(1).parse(JSON.parse(value));
    if (/["'|;&<>`$\\]/.test(value)) throw new Error("Use a JSON argument array");
    return z.array(z.string().min(1)).min(1).parse(value.split(/\s+/));
  });
  return EasyOptions.parse({ model, capabilities, ...(mediaModel ? { mediaModel } : {}), ...(baseBranch ? { baseBranch } : {}), trigger, signature, authors, everySeconds, autoMerge: { enabled, method }, check });
}
