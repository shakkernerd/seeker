import { randomBytes } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fail } from "../core/validation.ts";

export const version = "0.1.0";
export const runtimeVersion = "1.4.2";

export function defaultDataDir(fixture = false): string {
  return resolve(process.env.SEEKER_DATA_DIR ?? join(homedir(), ".local", "share", fixture ? "seeker-demo" : "seeker"));
}

export function ensureDataDir(directory: string): string {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("unsafe_directory", "Use a private data directory (mode 700) owned by your user.");
  }
  if (process.getuid && stat.uid !== process.getuid()) fail("unsafe_directory", "The data directory belongs to another user.");
  return path;
}

export function loadAccessKey(directory: string): string {
  const path = join(ensureDataDir(directory), "access.key");
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, `${randomBytes(32).toString("hex")}\n`); }
    finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.isSymbolicLink()) fail("unsafe_key", "The access key must be a private regular file (mode 600).");
  const key = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) fail("invalid_key", "The stored access key is invalid. Recover the original key or deliberately replace it while Seeker is stopped.");
  return key;
}
