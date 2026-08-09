const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

async function main() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vico-claude-monitor-"));
  const testUserData = path.join(testRoot, "VicoUserData");
  process.env.VICO_CLAUDE_HOME = testRoot;

  const settingsDir = path.join(testRoot, ".claude");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    env: { SENTINEL: "keep-me" },
    hooks: {
      Notification: [{ matcher: "existing", hooks: [{ type: "command", command: "existing-hook" }] }]
    }
  }), "utf8");

  const monitor = require("../electron/claude-monitor.cjs");
  const installed = monitor.installHooks(testUserData);
  assert.equal(installed.installed, true);
  assert.equal(installed.hookVersion, monitor.HOOK_VERSION);
  assert(monitor.HOOK_EVENTS.includes("PermissionRequest"));
  assert(monitor.HOOK_EVENTS.includes("StopFailure"));

  const merged = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"));
  assert.equal(merged.env.SENTINEL, "keep-me");
  assert(merged.hooks.Notification.some((entry) => entry.matcher === "existing"));
  const vicoHook = merged.hooks.PreToolUse.find((entry) =>
    entry.hooks?.some((hookEntry) => hookEntry.command?.includes(installed.scriptPath))
  );
  assert(vicoHook);
  assert(vicoHook.hooks[0].command.startsWith("powershell.exe -NoProfile"));
  assert.equal(vicoHook.hooks[0].args, undefined);

  let currentTime = 1000;
  const tracked = [];
  const tracker = monitor.createStatusTracker((status) => tracked.push(status), {
    now:() => currentTime,
    staleMs:100
  });
  tracker.push({ sessionId:"session-a", state:"working", event:"UserPromptSubmit" });
  currentTime += 10;
  const aggregate = tracker.push({ sessionId:"session-b", state:"done", event:"Stop" });
  assert.equal(aggregate.sessionId, "session-a");
  assert.equal(aggregate.activeSessions, 2);
  assert.equal(aggregate.observed.sessionId, "session-b");
  currentTime += 10;
  const afterEnd = tracker.push({ sessionId:"session-a", state:"offline", event:"SessionEnd" });
  assert.equal(afterEnd.sessionId, "session-b");
  currentTime += 200;
  assert.equal(tracker.expire().state, "offline");

  const testPort = 39000 + process.pid % 1000;
  let timeout;
  let server;
  const received = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Hook status timeout")), 5000);
    server = monitor.startStatusServer((status) => {
      if (status.event === "PreToolUse") {
        clearTimeout(timeout);
        server.close();
        resolve(status);
      }
    }, { port:testPort });
  });
  await new Promise((resolve) => server.once("listening", resolve));

  // 通过 shell-form 完整命令执行，复现 Claude Code 2.1.105 的 Hook 启动方式。
  const hook = spawn(vicoHook.hooks[0].command, [], {
    shell:true,
    stdio:["pipe", "ignore", "pipe"],
    env:{ ...process.env, VICO_STATUS_PORT:String(testPort) }
  });
  hook.stdin.end(JSON.stringify({ tool_name: "Bash" }));

  const status = await received;
  assert.equal(status.state, "tool");
  assert.equal(status.tool, "Bash");
  assert.equal(status.text, "Running Bash");

  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log("Claude monitor hook merge and relay test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
