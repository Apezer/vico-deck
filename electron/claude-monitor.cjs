const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const STATUS_PORT = 38471;
const HOOK_VERSION = 3;
const SESSION_STALE_MS = 10 * 60 * 1000;
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd"
];

const BRIDGE_SCRIPT = `# Vico Claude Hook Version: ${HOOK_VERSION}
param([string]$EventName = "Unknown")
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
  $sessionId = ShortText ([string]$payload.session_id) 64
  $cwd = ShortText ([string]$payload.cwd) 120
  $notificationType = ShortText ([string]$payload.notification_type) 32
  $agentType = ShortText ([string]$payload.agent_type) 14
  $message = ShortText ([string]$payload.message) 42
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
    "PermissionRequest" {
      $state = "waiting"
      $text = $(if ($tool) { "Permission: " + $tool } else { "Permission required" })
    }
    "PermissionDenied" {
      $state = "error"
      $text = $(if ($tool) { $tool + " denied" } else { "Permission denied" })
    }
    "Notification" {
      if ($notificationType -in @("permission_prompt", "idle_prompt", "agent_needs_input")) {
        $state = "waiting"
      } elseif ($notificationType -eq "agent_completed") {
        $state = "done"
      } else {
        $state = "ready"
      }
      $text = $(if ($message) { $message } else { "Claude notification" })
    }
    "SubagentStart" {
      $state = "tool"
      $tool = $(if ($agentType) { $agentType } else { "Agent" })
      $text = "Starting " + $tool
    }
    "SubagentStop" {
      $state = "working"
      $tool = $(if ($agentType) { $agentType } else { "Agent" })
      $text = $tool + " complete"
    }
    "Stop" { $state = "done"; $tool = ""; $text = "Task complete" }
    "StopFailure" { $state = "error"; $tool = ""; $text = "Task stopped unexpectedly" }
    "SessionEnd" { $state = "offline"; $tool = ""; $text = "Session ended" }
  }

  $body = @{
    state = $state
    tool = $tool
    text = (ShortText $text 42)
    event = $EventName
    sessionId = $sessionId
    cwd = $cwd
    notificationType = $notificationType
  } | ConvertTo-Json -Compress
  $statusPort = $(if ($env:VICO_STATUS_PORT) { $env:VICO_STATUS_PORT } else { "${STATUS_PORT}" })
  Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $statusPort + "/claude-status") -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1 | Out-Null
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
  // Claude Code 2.1.105 会忽略 command hook 的 args 数组。
  // 使用完整 shell-form 命令可同时兼容旧 CLI 和新版 VS Code 扩展。
  const escapedPath = scriptPath.replaceAll('"', '`"');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${escapedPath}" ${eventName}`;
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
  return entry?.hooks?.some((hook) => hook?.type === "command" && (
    (typeof hook.command === "string" && hook.command.includes(scriptPath)) ||
    (Array.isArray(hook.args) && hook.args.includes(scriptPath))
  ));
}

function installedScriptVersion(scriptPath) {
  try {
    const script = fs.readFileSync(scriptPath, "utf8");
    return Number(script.match(/Vico Claude Hook Version:\s*(\d+)/)?.[1] || 0);
  } catch {
    return 0;
  }
}

function getHooksState(userDataPath) {
  const scriptPath = hookScriptPath(userDataPath);
  const { settingsFile, settings } = readSettings();
  const installedEvents = HOOK_EVENTS.filter((eventName) =>
    Array.isArray(settings.hooks?.[eventName]) &&
    settings.hooks[eventName].some((entry) => hookIsOurs(entry, scriptPath))
  );
  const hookVersion = installedScriptVersion(scriptPath);
  const current = hookVersion === HOOK_VERSION;

  return {
    installed: installedEvents.length === HOOK_EVENTS.length && current,
    needsUpgrade: installedEvents.length > 0 && (!current || installedEvents.length < HOOK_EVENTS.length),
    installedEvents,
    hookVersion,
    expectedHookVersion: HOOK_VERSION,
    settingsFile,
    scriptPath
  };
}

function installHooks(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const scriptPath = hookScriptPath(userDataPath);
  fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, "utf8");

  const { settingsFile, settings } = readSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  for (const eventName of HOOK_EVENTS) {
    const current = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const withoutOldVicoHooks = current.filter((entry) => !hookIsOurs(entry, scriptPath));
    withoutOldVicoHooks.push({
      matcher: "",
      hooks: [{
        type: "command",
        command: hookCommand(scriptPath, eventName),
        timeout: 5
      }]
    });
    settings.hooks[eventName] = withoutOldVicoHooks;
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tempFile = `${settingsFile}.vico.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tempFile, settingsFile);
  return getHooksState(userDataPath);
}

function normalizeStatus(value, timestamp = Date.now()) {
  const allowedStates = new Set(["ready", "working", "tool", "waiting", "done", "error", "offline"]);
  const state = allowedStates.has(value?.state) ? value.state : "working";
  return {
    state,
    tool: String(value?.tool || "").replace(/[\r\n\t]/g, " ").slice(0, 14),
    text: String(value?.text || "Claude Code is working").replace(/[\r\n\t]/g, " ").slice(0, 42),
    event: String(value?.event || "Unknown").slice(0, 32),
    sessionId: String(value?.sessionId || "legacy").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "legacy",
    cwd: String(value?.cwd || "").replace(/[\r\n\t]/g, " ").slice(0, 120),
    notificationType: String(value?.notificationType || "").slice(0, 32),
    updatedAt: timestamp
  };
}

/** 合并多个 Claude Code 会话，避免已结束会话覆盖仍在工作的会话。 */
function createStatusTracker(onStatus, options = {}) {
  const sessions = new Map();
  const now = options.now || Date.now;
  const staleMs = options.staleMs || SESSION_STALE_MS;
  const priority = { waiting:70, error:65, tool:60, working:50, ready:40, done:20, offline:0 };
  let lastResult = null;
  let lastSignature = "";

  const publish = (observed = null) => {
    const timestamp = now();
    for (const [sessionId, status] of sessions) {
      if (timestamp - status.updatedAt > staleMs) sessions.delete(sessionId);
    }
    const active = [...sessions.values()].sort((left, right) =>
      (priority[right.state] - priority[left.state]) || (right.updatedAt - left.updatedAt)
    );
    const selected = active[0] || normalizeStatus({
      state:"offline", tool:"", text:"Waiting for Claude Code", event:"SessionTimeout"
    }, timestamp);
    const signature = [selected.sessionId, selected.state, selected.tool, selected.text, sessions.size].join("|");
    if (!observed && signature === lastSignature && lastResult) return lastResult;
    const result = { ...selected, activeSessions:sessions.size, observed };
    lastResult = result;
    lastSignature = signature;
    onStatus(result);
    return result;
  };

  return {
    push(value) {
      const status = normalizeStatus(value, now());
      if (status.state === "offline" || status.event === "SessionEnd") sessions.delete(status.sessionId);
      else sessions.set(status.sessionId, status);
      return publish(status);
    },
    expire:publish,
    size:() => sessions.size
  };
}

function startStatusServer(onStatus, options = {}) {
  const tracker = createStatusTracker(onStatus);
  const port = options.port ?? STATUS_PORT;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok:true, activeSessions:tracker.size(), hookVersion:HOOK_VERSION }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/claude-status") {
      response.writeHead(404);
      response.end();
      return;
    }

    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) tooLarge = true;
    });
    request.on("end", () => {
      if (tooLarge) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok:false, error:"Payload too large" }));
        return;
      }
      try {
        const status = tracker.push(JSON.parse(body || "{}"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok:true, activeSessions:status.activeSessions }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok:false, error:error.message }));
      }
    });
  });

  server.listen(port, "127.0.0.1");
  const expiryTimer = setInterval(() => tracker.expire(), 15000);
  expiryTimer.unref?.();
  server.on("close", () => clearInterval(expiryTimer));
  server.on("error", (error) => {
    onStatus(normalizeStatus({
      state:"error",
      text:error.code === "EADDRINUSE" ? "Relay port is already in use" : "Relay service failed",
      event:"RelayError"
    }));
  });
  return server;
}

module.exports = {
  STATUS_PORT,
  HOOK_VERSION,
  HOOK_EVENTS,
  createStatusTracker,
  getHooksState,
  installHooks,
  normalizeStatus,
  startStatusServer
};
