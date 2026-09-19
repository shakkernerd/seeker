import { expect, test } from "bun:test";
import { codeHomeFromProcessRecord, userDataFromProcessRecord } from "../src/hosts/codex/desktop-selectors.ts";

const executable = "/Applications/Registered.app/Contents/Resources/codex";
function execRecord(environment: string[], arguments_ = [executable, "app-server", "CODEX_HOME=/argument-decoy"]): Uint8Array {
  const header = new Uint8Array(4); new DataView(header.buffer).setInt32(0, arguments_.length, true);
  return new Uint8Array(Buffer.concat([header, Buffer.from(`${executable}\0\0${arguments_.join("\0")}\0${environment.join("\0")}\0\0`)]));
}

test("exact native home selectors survive spaces and ignore unrelated argument and environment values", () => {
  const bytes = execRecord(["HOME=/Users/example", "PRIVATE_VALUE=contains CODEX_HOME=/environment-decoy and spaces", "CODEX_HOME=/Users/example/Codex Profile"]);
  expect(codeHomeFromProcessRecord(bytes, executable)).toBe("/Users/example/Codex Profile");
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  const fallback = execRecord(["HOME=/Users/example", "PRIVATE_VALUE=CODEX_HOME=/decoy"]);
  expect(codeHomeFromProcessRecord(fallback, executable)).toBe("/Users/example/.codex");
  expect(fallback.every((byte) => byte === 0)).toBe(true);
});

test("ambiguous, missing or malformed selectors fail without disclosing or retaining the raw record", () => {
  for (const environment of [[], ["HOME=relative"], ["HOME=/Users/example", "CODEX_HOME="], ["CODEX_HOME=/a", "CODEX_HOME=/b"], ["CODEX_HOME=/a/../b"], ["CODEX_HOME=/a\nprivate-marker"], [`CODEX_HOME=/${"x".repeat(4_096)}`]]) {
    const bytes = execRecord([...environment, "PRIVATE_VALUE=private-marker"]);
    let error: unknown;
    try { codeHomeFromProcessRecord(bytes, executable); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private-marker");
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  }
  const wrongOwner = execRecord(["HOME=/Users/example"]);
  expect(() => codeHomeFromProcessRecord(wrongOwner, "/other/codex")).toThrow();
  expect(wrongOwner.every((byte) => byte === 0)).toBe(true);
  const truncated = execRecord(["HOME=/Users/example"]).slice(0, -3);
  expect(() => codeHomeFromProcessRecord(truncated, executable)).toThrow();
  expect(truncated.every((byte) => byte === 0)).toBe(true);
});

test("native profile arguments keep switch-like directory text inside its actual argv boundary", () => {
  const selected = "/Users/example/Profile --flag=value";
  const bytes = execRecord(["PRIVATE_VALUE=--user-data-dir=/environment-decoy"], [executable, `--user-data-dir=${selected}`, "--lang=en-US"]);
  expect(userDataFromProcessRecord(bytes, executable)).toBe(selected);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  const absent = execRecord(["PRIVATE_VALUE=--user-data-dir=/environment-decoy"]);
  expect(userDataFromProcessRecord(absent, executable)).toBeUndefined();
  expect(absent.every((byte) => byte === 0)).toBe(true);
  for (const arguments_ of [["--user-data-dir=/a", "--user-data-dir=/b"], ["--user-data-dir", "/a"], ["--user-data-dir="], ["--user-data-dir=relative"], ["--user-data-dir=/a\nprivate-marker"]]) {
    const malformed = execRecord(["PRIVATE_VALUE=private-marker"], [executable, ...arguments_]);
    let error: unknown;
    try { userDataFromProcessRecord(malformed, executable); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private-marker");
    expect(malformed.every((byte) => byte === 0)).toBe(true);
  }
});
