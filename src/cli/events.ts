import { resolve } from "node:path";
import { prepareEventCapability, readEventResult, signalEvent } from "../core/event-client.ts";
import { fail } from "../core/validation.ts";
import { runtimeVersion } from "../local/config.ts";

const help = `Usage:
  seeker event prepare --capability-file <new-private-path> --revision <source-revision> [--wait-id <unique-id>]
  seeker event signal --capability-file <private-path> --endpoint http://127.0.0.1:<port> --result-file <path>

Prepare writes a new private producer key and prints only the wait identity and digest.
Arm that identity from the original native task with event_arm, title and an explicit expiresAt.
The existing job/dependency owner signals its own result file: eventId, outcome
(completed, released or failed), summary and evidenceRefs. No job is started by Seeker.
An uncertain signal response can be retried with the same exact result and identity.
Never print or pass the capability file contents through model tools, logs or argv.
`;

export async function runEventCommand(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help")) { console.log(help); return; }
  if (Bun.version !== runtimeVersion) fail("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  const action = args.shift();
  if (action !== "prepare" && action !== "signal") fail("unknown_command", help);
  const input: Record<string, string> = {};
  const allowed = action === "prepare" ? ["--capability-file", "--revision", "--wait-id"] : ["--capability-file", "--endpoint", "--result-file"];
  while (args.length) {
    const option = args.shift()!, value = args.shift();
    if (!allowed.includes(option) || !value || value.startsWith("--") || input[option] !== undefined) fail("invalid_option", help);
    input[option] = value;
  }
  if (!input["--capability-file"]) fail("missing_option", help);
  const path = resolve(input["--capability-file"]);
  if (action === "prepare") {
    if (!input["--revision"]) fail("missing_option", help);
    console.log(JSON.stringify(prepareEventCapability(path, { revision: input["--revision"], ...(input["--wait-id"] ? { waitId: input["--wait-id"] } : {}) })));
  } else {
    if (!input["--endpoint"] || !input["--result-file"]) fail("missing_option", help);
    console.log(JSON.stringify(await signalEvent({ endpoint: input["--endpoint"], capabilityFile: path, result: readEventResult(resolve(input["--result-file"])) })));
  }
}
