const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { UPDATE_URL, UpdateService } = require("../electron/update-service.cjs");

class FakeUpdater extends EventEmitter {
  setFeedURL(value) { this.feed = value; }
  async checkForUpdates() {
    this.emit("checking-for-update");
    this.emit("update-available", { version:"0.3.0" });
  }
  async downloadUpdate() {
    this.emit("download-progress", { percent:42, transferred:42, total:100 });
    this.emit("update-downloaded", { version:"0.3.0" });
  }
  quitAndInstall(silent, forceRunAfter) {
    this.installArgs = { silent, forceRunAfter };
  }
}

async function run() {
  const updater = new FakeUpdater();
  const events = [];
  const window = {
    isDestroyed:() => false,
    webContents:{ send:(_channel, value) => events.push(value) }
  };
  const service = new UpdateService({
    app:{ getVersion:() => "0.2.0", isPackaged:true },
    autoUpdater:updater,
    getWindow:() => window
  });

  service.start();
  assert.deepEqual(updater.feed, { provider:"generic", url:UPDATE_URL });
  assert.equal(updater.autoDownload, false);

  assert.equal((await service.check()).status, "available");
  assert.equal(service.snapshot().version, "0.3.0");
  assert.equal((await service.download()).status, "downloaded");
  assert.equal(service.snapshot().percent, 100);
  assert.ok(events.some((event) => event.status === "downloading" && event.percent === 42));

  assert.equal(service.install(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updater.installArgs, { silent:false, forceRunAfter:true });

  const development = new UpdateService({
    app:{ getVersion:() => "0.2.0", isPackaged:false },
    autoUpdater:new FakeUpdater(),
    getWindow:() => null
  });
  development.start();
  assert.equal((await development.check()).status, "development");
}

run().then(() => console.log("Update service passed: check, download and install states"));
