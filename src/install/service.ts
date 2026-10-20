import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, closeSync, constants, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../core/validation.ts";
import { ensureDataDir } from "../local/config.ts";
import { atomicWrite, layout, present, privateSubdirectory, regular, serviceLabel } from "./layout.ts";
import { readInstallation, verifyInstallation } from "./application.ts";

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function servicePlist(home: string, path: string): string {
  const p = layout(home);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array><string>${xml(join(p.bin, "seeker"))}</string><string>service</string><string>run</string><string>--home</string><string>${xml(p.home)}</string></array>
<key>WorkingDirectory</key><string>${xml(p.home)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
function launchctl(args: string[], allowMissing = false): string {
  const result = Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (result.exitCode !== 0 && !allowMissing) fail("service_operation", "launchctl could not complete the operation. Check service status in this user's login session.");
  return result.exitCode === 0 ? result.stdout.toString() : "";
}
const target = () => `gui/${process.getuid?.()}/${serviceLabel}`;
function ownedPlist(home: string): string {
  const path = layout(home).plist;
  regular(path);
  const text = readFileSync(path, "utf8");
  // Compare the complete generated definition, retaining only its recorded PATH.
  const match = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text);
  const pathValue = match?.[1]?.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
  if (pathValue === undefined || text !== servicePlist(home, pathValue)) fail("service_collision", "The service plist is not this installation's owned definition; it was preserved.");
  return text;
}
export async function serviceCommand(action: string, home: string, dryRun = false): Promise<unknown> {
  const p = layout(home);
  if (action === "logs") {
    const log = join(p.logs, "service.log");
    if (!present(log)) return { log, tail: "" };
    regular(log);
    const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 65_536));
      const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return { log, tail: bytes.subarray(0, count).toString("utf8") };
    } finally { closeSync(fd); }
  }
  if (action === "status") {
    const installed = readInstallation(home);
    const registered = process.platform === "darwin" ? launchctl(["print", target()], true) : "";
    return { home: p.home, installedVersion: installed?.packageVersion ?? null, service: registered ? /state = ([^\n]+)/.exec(registered)?.[1]?.trim() ?? "registered" : "not loaded", pid: Number(/pid = (\d+)/.exec(registered)?.[1]) || null, loginDefinition: present(p.plist) ? "present" : "absent", store: present(join(p.home, "exchanges.sqlite")) ? "present" : "not created", connector: present(join(p.home, "codex-connector.json")) ? "configured" : "not configured", deliveryReadiness: "Verify a native event in the original task; service/config presence does not prove delivery." };
  }
  if (!["start", "stop", "restart", "enable", "disable"].includes(action)) fail("service_action", "Use service start|stop|restart|status|logs|enable|disable.");
  if (process.platform !== "darwin") fail("service_platform", "Managed service commands require macOS launchd; use seeker start in the foreground on this platform.");
  verifyInstallation(home);
  if (present(p.plist)) ownedPlist(home);
  const plan = { action, label: serviceLabel, plist: p.plist, home: p.home, loginStartup: action === "enable" ? "enabled" : action === "disable" ? "disabled" : "unchanged", stop: "Stops this login session; disable also prevents future login startup." };
  if (dryRun) return plan;
  if (["enable", "start", "restart"].includes(action) && present(join(p.home, ".installation-lock"))) fail("install_busy", "Finish installation or migration before starting the service.");
  const current = launchctl(["print", target()], true);
  if (current && !current.includes(`program = ${join(p.bin, "seeker")}\n`)) fail("service_collision", "The loaded service label belongs to another executable; it was preserved.");
  if (current && !present(p.plist)) fail("service_collision", "The service label is already registered without this installation's plist.");
  if (["stop", "disable", "restart"].includes(action) && current) {
    launchctl(["bootout", target()]);
    // bootout acceptance is not process settlement.
    const pid = Number(/pid = (\d+)/.exec(current)?.[1]);
    if (pid) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
        if (Date.now() >= deadline) fail("service_stopping", "The service has not settled; preserve the store and retry status.");
        await Bun.sleep(100);
      }
    }
  }
  if (action === "disable") {
    launchctl(["disable", target()]);
    if (present(p.plist)) unlinkSync(p.plist);
  }
  if (["enable", "start", "restart"].includes(action)) {
    const loaded = launchctl(["print", target()], true);
    if (!loaded) {
      if (!present(p.plist)) {
        if (action !== "enable") fail("service_disabled", "Enable the login service explicitly with seeker service enable first.");
        mkdirSync(join(p.plist, ".."), { recursive: true });
        atomicWrite(p.plist, servicePlist(home, process.env.PATH ?? "/usr/bin:/bin"));
      }
      launchctl(["enable", target()]);
      launchctl(["bootstrap", `gui/${process.getuid?.()}`, p.plist]);
    } else if (!/pid = \d+/.test(loaded)) {
      launchctl(["kickstart", target()]);
    }
  }
  return plan;
}
/** One in-process bounded sink; no log daemon, timer, payloads or model calls. */
export function managedLog(home: string): (line: string) => void {
  const p = layout(home); ensureDataDir(p.home); privateSubdirectory(p.logs);
  const path = join(p.logs, "service.log"), limit = 10 * 1024 * 1024;
  for (const candidate of [path, `${path}.1`, `${path}.2`]) if (present(candidate)) { regular(candidate); if ((present(candidate)!.mode & 0o077) !== 0) fail("log_permissions", "Service logs must be private files."); }
  return line => {
    const bytes = Buffer.from(`${new Date().toISOString()} ${line.slice(0, 8_192)}\n`);
    if ((present(path)?.size ?? 0) + bytes.length > limit) {
      if (present(`${path}.2`)) unlinkSync(`${path}.2`);
      if (present(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
      if (present(path)) renameSync(path, `${path}.1`);
    }
    const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { appendFileSync(fd, bytes); } finally { closeSync(fd); }
  };
}
