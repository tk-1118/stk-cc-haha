#!/usr/bin/env node
/**
 * Cross-platform: persist selected .env entries as user-level "global" env vars.
 *
 * - win32: User or Machine registry via PowerShell (Machine needs elevated shell).
 * - linux: ~/.config/environment.d/stk-cc-haha.conf (systemd --user session; re-login may be needed).
 * - darwin: managed block in ~/.zshrc (export ...); open a new terminal.
 *
 * Usage:
 *   node ./scripts/sync-env.mjs [--env-file <path>] [--keys K1,K2] [--line-start N] [--line-end N]
 *                               [--dry-run] [--scope User|Machine]
 *
 * Machine is only meaningful on Windows.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MARK_START = "# >>> stk-cc-haha-env >>>";
const MARK_END = "# <<< stk-cc-haha-env <<<";

function parseArgs(argv) {
  const out = {
    envFile: "",
    keys: null,
    lineStart: 0,
    lineEnd: 0,
    dryRun: false,
    scope: "User",
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--keys" && args[i + 1]) out.keys = splitKeys(args[++i]);
    else if (a.startsWith("--keys=")) out.keys = splitKeys(a.slice(7));
    else if (a === "--env-file" && args[i + 1]) out.envFile = args[++i];
    else if (a.startsWith("--env-file=")) out.envFile = a.slice(11);
    else if (a === "--line-start" && args[i + 1]) out.lineStart = Number(args[++i]);
    else if (a.startsWith("--line-start=")) out.lineStart = Number(a.slice(13));
    else if (a === "--line-end" && args[i + 1]) out.lineEnd = Number(args[++i]);
    else if (a.startsWith("--line-end=")) out.lineEnd = Number(a.slice(11));
    else if (a === "--scope" && args[i + 1]) out.scope = args[++i];
    else if (a.startsWith("--scope=")) out.scope = a.slice(8);
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node ./scripts/sync-env.mjs [options]
  --env-file <path>   Default: <repo>/.env
  --keys K1,K2        Only these variable names
  --line-start N      1-based inclusive (ignored if --keys set)
  --line-end N
  --dry-run
  --scope User|Machine  Windows only; Machine requires Administrator`);
      process.exit(0);
    }
  }
  return out;
}

function splitKeys(s) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseDotEnv(content, opts) {
  const useKeys = opts.keys && opts.keys.length > 0;
  const keySet = useKeys ? new Set(opts.keys) : null;
  const useLine =
    !useKeys && (opts.lineStart > 0 || opts.lineEnd > 0);
  const start = useLine ? (opts.lineStart > 0 ? opts.lineStart : 1) : 0;
  const end = useLine ? (opts.lineEnd > 0 ? opts.lineEnd : Number.MAX_SAFE_INTEGER) : 0;

  const lines = content.split(/\r?\n/);
  const entries = [];
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;
    if (useLine) {
      if (lineNumber < start) continue;
      if (lineNumber > end) break;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;

    let name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!name) continue;

    if (useKeys && !keySet.has(name)) continue;

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    entries.push([name, value]);
  }

  return entries;
}

function hideValue(name, value) {
  if (/(token|secret|password|credential|api_?key)/i.test(name)) return "***";
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shSingleQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** systemd environment.d: quote if needed */
function systemdLine(name, value) {
  const safe = /^[A-Za-z0-9_.,:/@%+\-]+$/.test(value);
  if (safe) return `${name}=${value}`;
  const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
  return `${name}="${esc}"`;
}

function upsertZshBlock(zshrcPath, exportLines, dryRun) {
  const block = [MARK_START, ...exportLines, MARK_END].join("\n") + "\n";
  let existing = "";
  try {
    existing = readFileSync(zshrcPath, "utf8");
  } catch {
    // create
  }
  const re = new RegExp(
    `${escapeRegex(MARK_START)}[\\s\\S]*?${escapeRegex(MARK_END)}\\n?`,
    "m"
  );
  const next = re.test(existing)
    ? existing.replace(re, block)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;

  if (dryRun) {
    console.log(`[dry-run] would write: ${zshrcPath}`);
    console.log(block);
    return;
  }
  writeFileSync(zshrcPath, next, { mode: 0o600 });
  try {
    chmodSync(zshrcPath, 0o600);
  } catch {
    /* ignore */
  }
  console.log(`Wrote managed block in ${zshrcPath}`);
}

function writeLinuxEnvironmentD(entries, dryRun) {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = join(configHome, "environment.d");
  const file = join(dir, "stk-cc-haha.conf");
  const body =
    `# Generated by stk-cc-haha scripts/sync-env.mjs — do not edit by hand\n` +
    entries.map(([k, v]) => systemdLine(k, v)).join("\n") +
    "\n";

  if (dryRun) {
    console.log(`[dry-run] would write: ${file}`);
    console.log(body);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, body, { mode: 0o600 });
  console.log(`Wrote ${file}`);
  console.log(
    "Tip: systemd user session loads these after login; you may need to re-login or restart the session."
  );
}

function runPowerShellSetEnv(entries, scope, dryRun) {
  if (dryRun) {
    for (const [name, value] of entries) {
      console.log(`[dry-run] ${name}=${hideValue(name, value)}`);
    }
    return;
  }

  const tmp = join(
    tmpdir(),
    `stk-cc-haha-env-${randomBytes(8).toString("hex")}.json`
  );
  const obj = Object.fromEntries(entries);
  writeFileSync(tmp, JSON.stringify(obj), "utf8");

  const psScope = scope === "Machine" ? "Machine" : "User";
  const tmpLiteral = tmp.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$path = '${tmpLiteral}'
$j = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
$j.PSObject.Properties | ForEach-Object {
  [Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, '${psScope}')
}
Remove-Item -LiteralPath $path -Force
`;

  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "PowerShell failed");
    process.exit(r.status ?? 1);
  }
  for (const [name, value] of entries) {
    console.log(`Set: ${name}=${hideValue(name, value)}`);
  }
}

function assertWinAdminIfMachine(scope) {
  if (scope !== "Machine") return;
  const chk = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { encoding: "utf8" }
  );
  const ok = String(chk.stdout || "").trim().toLowerCase() === "true";
  if (!ok) {
    console.error("Scope Machine requires Administrator PowerShell / terminal.");
    process.exit(1);
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const envPath = opts.envFile
    ? resolve(opts.envFile)
    : resolve(__dirname, "..", ".env");

  if (!existsSync(envPath)) {
    console.error(`Env file not found: ${envPath}`);
    process.exit(1);
  }

  const raw = readFileSync(envPath, "utf8");
  const entries = parseDotEnv(raw, opts);

  if (entries.length === 0) {
    console.error("No matching variables to sync.");
    process.exit(1);
  }

  const plat = process.platform;

  if (plat === "win32") {
    if (opts.scope !== "User" && opts.scope !== "Machine") {
      console.error("--scope must be User or Machine on Windows.");
      process.exit(1);
    }
    if (opts.scope === "Machine") assertWinAdminIfMachine(opts.scope);
    runPowerShellSetEnv(entries, opts.scope, opts.dryRun);
    if (!opts.dryRun) {
      console.log("");
      console.log("Done. Open a new terminal so apps pick up the new values.");
    }
    return;
  }

  if (plat === "darwin") {
    const exportLines = entries.map(
      ([name, value]) => `export ${name}=${shSingleQuote(value)}`
    );
    const zshrc = join(homedir(), ".zshrc");
    upsertZshBlock(zshrc, exportLines, opts.dryRun);
    if (!opts.dryRun) {
      console.log("");
      console.log("Done. Open a new terminal or run: source ~/.zshrc");
    }
    return;
  }

  if (plat === "linux") {
    writeLinuxEnvironmentD(entries, opts.dryRun);
    if (!opts.dryRun) {
      console.log("");
      console.log("Done. Re-login or restart your user session if variables are missing in apps.");
    }
    return;
  }

  console.error(
    `Unsupported platform: ${plat}. Use manual export or contribute a backend.`
  );
  process.exit(1);
}

main();
