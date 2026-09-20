const UPDATE_URL = "https://update.zheng2005.xyz/";

/**
 * 将 electron-updater 的事件封装成可序列化状态，供渲染进程安全展示。
 * 下载和安装只能通过这里暴露的方法触发，渲染进程无法控制更新地址。
 */
class UpdateService {
  constructor({ app, autoUpdater, getWindow }) {
    this.app = app;
    this.autoUpdater = autoUpdater;
    this.getWindow = getWindow;
    this.started = false;
    this.state = {
      status:"idle",
      currentVersion:app.getVersion(),
      version:null,
      percent:0,
      message:"点击按钮检查新版本"
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.autoUpdater.setFeedURL({ provider:"generic", url:UPDATE_URL });

    this.autoUpdater.on("checking-for-update", () => {
      this.setState("checking", { percent:0, message:"正在检查更新…" });
    });
    this.autoUpdater.on("update-available", (info) => {
      this.setState("available", {
        version:String(info?.version || ""),
        percent:0,
        message:`发现新版本 ${info?.version || ""}`.trim()
      });
    });
    this.autoUpdater.on("update-not-available", (info) => {
      this.setState("up-to-date", {
        version:String(info?.version || this.app.getVersion()),
        percent:0,
        message:"当前已经是最新版本"
      });
    });
    this.autoUpdater.on("download-progress", (progress = {}) => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      this.setState("downloading", {
        percent,
        transferred:Number(progress.transferred) || 0,
        total:Number(progress.total) || 0,
        bytesPerSecond:Number(progress.bytesPerSecond) || 0,
        message:`正在下载更新 ${Math.round(percent)}%`
      });
    });
    this.autoUpdater.on("update-downloaded", (info) => {
      this.setState("downloaded", {
        version:String(info?.version || this.state.version || ""),
        percent:100,
        message:"更新已下载，重启软件即可安装"
      });
    });
    this.autoUpdater.on("error", (error) => {
      this.setState("error", {
        percent:0,
        message:this.errorMessage(error)
      });
    });
  }

  snapshot() {
    return { ...this.state };
  }

  async check() {
    if (!this.app.isPackaged) {
      return this.setState("development", {
        message:"开发模式不执行自动更新，请在安装版中测试"
      });
    }
    if (this.state.status === "checking" || this.state.status === "downloading") {
      return this.snapshot();
    }
    try {
      this.setState("checking", { percent:0, message:"正在检查更新…" });
      await this.autoUpdater.checkForUpdates();
      return this.snapshot();
    } catch (error) {
      this.setState("error", { percent:0, message:this.errorMessage(error) });
      return this.snapshot();
    }
  }

  async download() {
    if (!this.app.isPackaged) return this.check();
    if (this.state.status !== "available") {
      throw new Error("当前没有等待下载的新版本");
    }
    try {
      this.setState("downloading", { percent:0, message:"正在准备下载更新…" });
      await this.autoUpdater.downloadUpdate();
      return this.snapshot();
    } catch (error) {
      this.setState("error", { percent:0, message:this.errorMessage(error) });
      return this.snapshot();
    }
  }

  install() {
    if (this.state.status !== "downloaded") {
      throw new Error("更新尚未下载完成");
    }
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return true;
  }

  setState(status, patch = {}) {
    this.state = {
      ...this.state,
      ...patch,
      status,
      currentVersion:this.app.getVersion()
    };
    const window = this.getWindow?.();
    if (window && !window.isDestroyed()) {
      window.webContents.send("updater:state-changed", this.snapshot());
    }
    return this.snapshot();
  }

  errorMessage(error) {
    const message = String(error?.message || "检查更新失败");
    if (/404|latest\.yml/i.test(message)) {
      return "更新服务器尚未发布版本文件";
    }
    if (/net::|network|ENOTFOUND|ECONN/i.test(message)) {
      return "无法连接更新服务器，请检查网络后重试";
    }
    return message.slice(0, 240);
  }
}

module.exports = { UPDATE_URL, UpdateService };
