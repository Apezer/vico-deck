const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const STATUS_PORT = 38471;
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SessionEnd"
];

const BRIDGE_SCRIPT = `param([string]$EventName = "Unknown")
$ErrorActionPreference = "SilentlyContinue"

function ShortText([string]$Value, [int]$MaxLength = 42) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $clean = ($Value -replace "[\\r\\n\\t]+", " " -replace "\\s+", " ").Trim()
  if ($clean.Length -gt $MaxLength) { return $clean.Substring(0, $MaxLength - 3) + "..." }
  return $clean
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { $payload = @{} }
  else { $payload = $raw | ConvertFrom-Json }

  $tool = ShortText ([string]$payload.tool_name) 14
  $state = "working"
  $text = "Claude Code is working"

  switch ($EventName) {
    "SessionStart" { $state = "ready"; $text = "Session started" }
    "UserPromptSubmit" { $state = "working"; $text = "Thinking about request" }
    "PreToolUse" {
      $state = "tool"
      $text = "Running " + $(if ($tool) { $tool } else { "tool" })
    }
    "PostToolUse" {
      $state = "working"
      $text = $(if ($tool) { $tool + " complete" } else { "Tool complete" })
    }
    "PostToolUseFailure" {
      $state = "error"
      $text = $(if ($tool) { $tool + " failed" } else { "Tool failed" })
    }
    "Notification" { $state = "waiting"; $text = "Needs attention" }
    "Stop" { $state = "done"; $tool = ""; $text = "Task complete" }
    "SessionEnd" { $state = "offline"; $tool = ""; $text = "Session ended" }
  }

  $body = @{ state = $state; tool = $tool; text = (ShortText $text 42); event = $EventName } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:${STATUS_PORT}/claude-status" -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1 | Out-Null
} catch { }

exit 0
`;

function claudeSettingsPath() {
  return path.join(process.env.VICO_CLAUDE_HOME || os.homedir(), ".claude", "settings.json");
}

function hookScriptPath(userDataPath) {
  return path.join(userDataPath, "claude-hook.ps1");
}

function hookCommand(scriptPath, eventName) {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" ${eventName}`;
}

function readSettings() {
  const settingsFile = claudeSettingsPath();
  try {
    return { settingsFile, settings: JSON.parse(fs.readFileSync(settingsFile, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { settingsFile, settings: {} };
    throw new Error(`Claude Code settings.json 无法解析：${error.message}`);
  }
}

function hookIsOurs(entry, scriptPath) {
  return entry?.hooks?.some((hook) =>
    hook?.type === "command" && typeof hook.command === "string" && hook.command.includes(scriptPath)
  );
}

function getHooksState(userDataPath) {
  const scriptPath = hookScriptPath(userDataPath);
  const { settingsFile, settings } = readSettings();
  const installedEvents = HOOK_EVENTS.filter((eventName) =>
    Array.isArray(settings.hooks?.[eventName]) &&
    settings.hooks[eventName].some((entry) => hookIsOurs(entry, scriptPath))
  );

  return {
    installed: installedEvents.length === HOOK_EVENTS.length && fs.existsSync(scriptPath),
    installedEvents,
    settingsFile,
    scriptPath
  };
}

function installHooks(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(hookScriptPath(userDataPath), BRIDGE_SCRIPT, "utf8");

  const { settingsFile, settings } = readSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  for (const eventName of HOOK_EVENTS) {
    const current = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const withoutOldVicoHooks = current.filter((entry) => !hookIsOurs(entry, hookScriptPath(userDataPath)));
    withoutOldVicoHooks.push({
      matcher: "",
      hooks: [{ type: "command", command: hookCommand(hookScriptPath(userDataPath), eventName), timeout: 5 }]
    });
    settings.hooks[eventName] = withoutOldVicoHooks;
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tempFile = `${settingsFile}.vico.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tempFile, settingsFile);
  return getHooksState(userDataPath);
}

function normalizeStatus(value) {
  const allowedStates = new Set(["ready", "working", "tool", "waiting", "done", "error", "offline"]);
  const state = allowedStates.has(value?.state) ? value.state : "working";
  return {
    state,
    tool: String(value?.tool || "").replace(/[\r\n\t]/g, " ").slice(0, 14),
    text: String(value?.text || "Claude Code is working").replace(/[\r\n\t]/g, " ").slice(0, 42),
    event: String(value?.event || "Unknown").slice(0, 32),
    updatedAt: Date.now()
  };
}

function startStatusServer(onStatus) {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/claude-status") {
      response.writeHead(404);
      response.end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) request.destroy();
    });
    request.on("end", () => {
      try {
        const status = normalizeStatus(JSON.parse(body || "{}"));
        onStatus(status);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
  });

  server.listen(STATUS_PORT, "127.0.0.1");
  server.on("error", (error) => {
    onStatus(normalizeStatus({
      state: "error",
      text: error.code === "EADDRINUSE" ? "Relay port is already in use" : "Relay service failed",
      event: "RelayError"
    }));
  });
  return server;
}

module.exports = {
  STATUS_PORT,
  getHooksState,
  installHooks,
  normalizeStatus,
  startStatusServer
};
