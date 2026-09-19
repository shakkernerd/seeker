import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ConnectorError } from "../codex/protocol.ts";
import { parseRegisteredOwner, type RegisteredCliOwner } from "./owner.ts";

export function readCliRegistration(path: string): RegisteredCliOwner | undefined {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size > 16_384 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new ConnectorError("unsafe_cli_registration", "CLI registration must be a private regular file.");
    return parseRegisteredOwner(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally { closeSync(descriptor); }
}

export function saveCliRegistration(path: string, registration: RegisteredCliOwner): void {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new ConnectorError("unsafe_cli_registration", "Preserve unrelated data at the CLI registration path.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(parseRegisteredOwner(registration))}\n`, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
