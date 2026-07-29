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

  const merged = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"));
  assert.equal(merged.env.SENTINEL, "keep-me");
  assert(merged.hooks.Notification.some((entry) => entry.matcher === "existing"));

  let timeout;
  const received = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Hook status timeout")), 5000);
    const server = monitor.startStatusServer((status) => {
      if (status.event === "PreToolUse") {
        clearTimeout(timeout);
        server.close();
        resolve(status);
      }
    });
  });

  const hook = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", installed.scriptPath, "PreToolUse"
  ], { stdio: ["pipe", "ignore", "pipe"] });
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
