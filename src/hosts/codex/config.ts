import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConnectorError, identifier, onlyKeys, record } from "./protocol.ts";

export interface CodexConnectorConfig {
  version: 2;
  hostId: string;
  socketPath: string;
  credentialFile: string;
}

export function readPrivateFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new ConnectorError("unsafe_config", "Native connector files must be private regular files owned by your user.");
    }
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

export function readConnectorConfig(path: string): CodexConnectorConfig {
  const input = record(JSON.parse(readPrivateFile(path)));
  if (input.version === 1) throw new ConnectorError("transport_upgrade_required", "Re-run seeker codex setup before starting this older native registration.");
  onlyKeys(input, ["version", "hostId", "socketPath", "credentialFile"]);
  const directory = privateDirectory(dirname(resolve(path)));
  if (input.version !== 2 || input.socketPath !== join(directory, "codex.sock") || input.credentialFile !== join(directory, "codex.key")) throw new ConnectorError("invalid_config", "Invalid private native connector configuration.");
  return { version: 2, hostId: identifier(input.hostId), socketPath: input.socketPath as string, credentialFile: input.credentialFile as string };
}

export function readConnectorCredential(path: string): string {
  const value = readPrivateFile(path).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ConnectorError("invalid_credential", "Invalid native connector credential.");
  return value;
}

/** Protect the address itself before disclosing a credential or any exchange data. */
export function privateDirectory(path: string): string {
  const directory = realpathSync(path);
  const uid = process.getuid?.();
  const leaf = lstatSync(directory);
  if (uid === undefined || !leaf.isDirectory() || leaf.uid !== uid || (leaf.mode & 0o077) !== 0) throw new ConnectorError("unsafe_directory", "Native connector state requires a private directory owned by your user.");
  let ancestor = dirname(directory);
  for (;;) {
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) throw new ConnectorError("unsafe_directory", "The native socket's parent directories must prevent another OS user replacing its address.");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return directory;
}

export function privateSocket(path: string): void {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 103 || join(privateDirectory(dirname(path)), "codex.sock") !== path) throw new ConnectorError("unsafe_socket", "Use the native socket created in Seeker's private data directory.");
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ConnectorError("unsafe_socket", "The native socket must be private and owned by your user.");
}
