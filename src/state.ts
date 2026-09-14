import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";

export interface Store<T> { load(): Promise<T>; save(value: T): Promise<void> }

export class JsonStore<T> implements Store<T> {
  constructor(readonly file: string, private schema: z.ZodType<T>, private initial: () => T) {}
  async load(): Promise<T> {
    try { return this.schema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial();
      throw error; // Never reset a corrupt queue silently.
    }
  }
  async save(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(validated, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, this.file); }
    finally { await rm(temporary, { force: true }); }
  }
}

export async function acquire(directory: string, name: string, compromised: (error: Error) => void, waitForPrevious = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return lockfile.lock(join(directory, name), {
    realpath: false, stale: 30_000, update: 10_000,
    // Location invalidation can start a replacement before the old plugin's
    // finalizers finish. Wait for release, never remove a live owner's lock.
    retries: waitForPrevious ? { retries: 30, factor: 1, minTimeout: 500, maxTimeout: 500 } : 0,
    onCompromised: compromised,
  });
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
}

export function redact(error: unknown, secrets: string[] = []): string {
  let message = describeError(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 2000);
}

function describeError(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object") return String(error);
  if (depth > 3) return "Nested error";
  const value = error as Record<string, unknown>;
  const parts = [...new Set([value._tag, value.type, value.name, value.message].filter(v => typeof v === "string" && v.trim()))];
  if (value.cause) parts.push(describeError(value.cause, depth + 1));
  return parts.join(": ") || `Unknown error (${Object.keys(value).join(", ") || "no details"})`;
}
