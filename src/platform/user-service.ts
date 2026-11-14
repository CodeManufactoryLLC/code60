import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicReplace, writePrivateFile } from "./storage.js";

export interface ServiceRuntime {
  executable: string;
  args: string[];
  env: Record<string, string>;
}
export interface UserServiceDefinition {
  path: string;
  contents: string;
  install: readonly string[][];
  start: readonly string[][];
  stop: readonly string[][];
  uninstall: readonly string[][];
  status: readonly string[];
}
const LABEL = "com.codemanufactory.code60.scheduler";
const TASK = "\\Code60 Scheduler";
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unit = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$")}"`;
const powershell = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function userServiceDefinition(
  platform: NodeJS.Platform,
  home: string,
  root: string,
  runtime: ServiceRuntime,
): UserServiceDefinition {
  if (
    !isAbsolute(runtime.executable) ||
    !isAbsolute(home) ||
    !isAbsolute(root) ||
    [runtime.executable, ...runtime.args, ...Object.values(runtime.env)].some((v) =>
      /[\0\r\n]/.test(v),
    ) ||
    Object.keys(runtime.env).some((v) => !/^[A-Z_][A-Z0-9_]*$/.test(v))
  )
    throw new Error("Invalid background runtime");
  if (platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const target = `gui/${process.getuid?.() ?? -1}`;
    return {
      path,
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${[runtime.executable, ...runtime.args].map((v) => `<string>${xml(v)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(runtime.env)
        .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
        .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`,
      install: [["launchctl", "bootstrap", target, path]],
      start: [
        ["launchctl", "bootstrap", target, path],
        ["launchctl", "kickstart", `${target}/${LABEL}`],
      ],
      stop: [["launchctl", "bootout", `${target}/${LABEL}`]],
      uninstall: [["launchctl", "bootout", `${target}/${LABEL}`]],
      status: ["launchctl", "print", `${target}/${LABEL}`],
    };
  }
  if (platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "code60-scheduler.service");
    return {
      path,
      contents: `[Unit]\nDescription=Code60 scheduled agents\n
[Service]\nType=simple
ExecStart=${[runtime.executable, ...runtime.args].map(unit).join(" ")}
${Object.entries(runtime.env)
  .map(([k, v]) => `Environment=${unit(`${k}=${v}`)}`)
  .join("\n")}
Restart=on-failure\nRestartSec=30\nTimeoutStopSec=60\nKillMode=control-group
\n[Install]\nWantedBy=default.target\n`,
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "code60-scheduler.service"],
      ],
      start: [["systemctl", "--user", "start", "code60-scheduler.service"]],
      stop: [["systemctl", "--user", "stop", "code60-scheduler.service"]],
      uninstall: [["systemctl", "--user", "disable", "--now", "code60-scheduler.service"]],
      status: ["systemctl", "--user", "is-active", "code60-scheduler.service"],
    };
  }
  if (platform === "win32") {
    const path = join(root, "scheduler-task.xml");
    const command = `${Object.entries(runtime.env)
      .map(([k, v]) => `$env:${k}=${powershell(v)};`)
      .join(
        "",
      )}& ${[runtime.executable, ...runtime.args].map(powershell).join(" ")};exit $LASTEXITCODE`;
    // PowerShell's encoded command is a transport for fixed, safely quoted arguments.
    const args = `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
    return {
      path,
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>powershell.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions></Task>\n`,
      install: [
        ["schtasks.exe", "/Create", "/TN", TASK, "/XML", path, "/F"],
        ["schtasks.exe", "/Run", "/TN", TASK],
      ],
      start: [["schtasks.exe", "/Run", "/TN", TASK]],
      stop: [["schtasks.exe", "/End", "/TN", TASK]],
      uninstall: [
        ["schtasks.exe", "/End", "/TN", TASK],
        ["schtasks.exe", "/Delete", "/TN", TASK, "/F"],
      ],
      status: ["schtasks.exe", "/Query", "/TN", TASK, "/FO", "CSV", "/NH"],
    };
  }
  throw new Error("Background scheduling is unsupported on this platform");
}

export type ServiceCommand = (argv: readonly string[]) => Promise<boolean>;
const runServiceCommand: ServiceCommand = (argv) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (!file) {
      resolve(false);
      return;
    }
    execFile(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }, (error) =>
      resolve(!error),
    );
  });

/** Only invoked after explicit consent, or repair of an already consented registration. */
export async function controlUserService(
  definition: UserServiceDefinition,
  action: "install" | "repair" | "start" | "stop" | "uninstall" | "status",
  command: ServiceCommand = runServiceCommand,
): Promise<{ available: boolean }> {
  if (action === "status") return { available: await command(definition.status) };
  if (action === "install" || action === "repair") {
    if (action === "repair") for (const argv of definition.stop) await command(argv);
    await mkdir(join(definition.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = join(definition.path, "..", `${randomUUID()}.tmp`);
    await writePrivateFile(temporary, definition.contents, { mode: 0o600, flag: "wx" });
    try {
      await atomicReplace(temporary, definition.path);
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    for (const argv of definition.install)
      if (!(await command(argv)))
        throw new Error(
          "Background service registration failed. The native user supervisor may be unavailable.",
        );
    return { available: true };
  }
  for (const argv of definition[action])
    if (!(await command(argv))) {
      // Bootstrap fails for an already loaded job; only a successful kickstart
      // proves that start succeeded. All other failures remain fatal.
      if (action === "start" && argv[0] === "launchctl" && argv[1] === "bootstrap") continue;
      throw new Error("Background service control failed. Check the native user supervisor.");
    }
  if (action === "uninstall") await unlink(definition.path);
  return { available: action === "start" };
}
