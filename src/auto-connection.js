export const AUTO_CONNECT_INTERVALS = [5, 10, 30, 60, 300, 600, 900, 1800];

function normalizeInterval(seconds) {
  const value = Number(seconds);
  return AUTO_CONNECT_INTERVALS.includes(value) ? value : 30;
}

/**
 * 管理 Vico Keyboard 的非交互式自动连接。
 *
 * 自动连接器按 USB、蓝牙顺序工作。蓝牙扫描由 Electron 主进程静默筛选
 * 名称精确匹配的 Vico Keyboard，不向用户弹出设备选择窗口。用户主动断开
 * 后暂停本次应用会话，直到用户手动连接、点击“立即尝试”或重新开启自动连接。
 */
export class AutoConnectionManager {
  constructor({
    restoreUsb,
    restoreBle,
    disconnectUsb = () => {},
    disconnectBle = () => {},
    isConnected,
    isBusy = () => false,
    onState = () => {},
    onConnected = () => {},
    // 使用包装函数保持浏览器原生计时器的正确调用上下文。
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    now = () => Date.now()
  }) {
    this.restoreUsb = restoreUsb;
    this.restoreBle = restoreBle;
    this.disconnectUsb = disconnectUsb;
    this.disconnectBle = disconnectBle;
    this.isConnected = isConnected;
    this.isBusy = isBusy;
    this.onState = onState;
    this.onConnected = onConnected;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.enabled = false;
    this.intervalSeconds = 30;
    this.lastTransport = null;
    this.manualPaused = false;
    this.running = false;
    // 连接尝试进行期间如果发现了新的传输通道，当前轮结束后立即再试一次。
    this.immediateRetryPending = false;
    this.timer = null;
    this.destroyed = false;
  }

  configure({ enabled, intervalSeconds, lastTransport }) {
    const wasEnabled = this.enabled;
    const previousInterval = this.intervalSeconds;
    this.enabled = Boolean(enabled);
    this.intervalSeconds = normalizeInterval(intervalSeconds);
    this.lastTransport = lastTransport === "ble" ? "ble" : lastTransport === "usb" ? "usb" : null;

    if (!this.enabled) {
      this.immediateRetryPending = false;
      this.clearScheduledAttempt();
      this.publish({ state:"disabled", nextAttemptAt:null });
      return;
    }

    if (!wasEnabled) this.manualPaused = false;
    if (this.manualPaused) {
      this.publish({ state:"paused", nextAttemptAt:null });
      return;
    }
    if (this.isConnected()) {
      this.clearScheduledAttempt();
      return;
    }
    if (wasEnabled && previousInterval !== this.intervalSeconds && this.timer !== null) {
      this.schedule(this.intervalSeconds * 1000, true);
      return;
    }
    this.schedule(0);
  }

  setBusy(busy) {
    if (!busy && this.enabled && !this.manualPaused && !this.isConnected()) this.schedule(0);
  }

  notifyConnected(transport) {
    // 自动连接关闭或用户主动断开后，不允许迟到的连接事件覆盖当前状态。
    if (!this.enabled || this.manualPaused) return;
    this.immediateRetryPending = false;
    this.clearScheduledAttempt();
    this.publish({ state:"connected", transport, nextAttemptAt:null });
  }

  notifyDisconnected() {
    if (!this.enabled || this.manualPaused) return;
    // 自动扫描失败也会发布 disconnected；运行中的这类状态不能触发紧密重试。
    // 真正新出现的 USB 通道由 notifyTransportAvailable() 单独处理。
    if (this.running) return;
    this.schedule(0, true);
  }

  /** USB 枚举或其他物理通道刚变为可用时，打断原来的定时等待。 */
  notifyTransportAvailable() {
    if (!this.enabled || this.manualPaused || this.isConnected()) return false;
    if (this.running) {
      this.immediateRetryPending = true;
      return true;
    }
    this.schedule(0, true);
    return true;
  }

  pauseForManualDisconnect() {
    this.manualPaused = true;
    this.immediateRetryPending = false;
    this.clearScheduledAttempt();
    this.publish({ state:this.enabled ? "paused" : "disabled", nextAttemptAt:null });
  }

  beginManualConnect() {
    this.manualPaused = false;
    this.immediateRetryPending = false;
    this.clearScheduledAttempt();
    this.publish({ state:this.enabled ? "connecting" : "disabled", manual:true, nextAttemptAt:null });
  }

  finishManualConnect(connected, transport = null) {
    if (connected) {
      this.onConnected(transport);
      if (this.enabled) this.notifyConnected(transport);
      else this.publish({ state:"disabled", nextAttemptAt:null });
    } else if (this.enabled) {
      this.schedule(this.intervalSeconds * 1000);
    } else {
      this.publish({ state:"disabled", nextAttemptAt:null });
    }
  }

  retryNow() {
    if (!this.enabled) return false;
    this.manualPaused = false;
    if (this.running) {
      this.immediateRetryPending = true;
      return true;
    }
    this.schedule(0, true);
    return true;
  }

  stop() {
    this.destroyed = true;
    this.immediateRetryPending = false;
    this.clearScheduledAttempt();
  }

  clearScheduledAttempt() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  schedule(delay, replace = false) {
    if (this.destroyed || !this.enabled || this.manualPaused || this.running || this.isConnected()) return;
    if (this.timer !== null && !replace) return;
    this.clearScheduledAttempt();
    const milliseconds = Math.max(0, Number(delay) || 0);
    this.publish({
      state:milliseconds === 0 ? "waiting" : "retrying",
      nextAttemptAt:this.now() + milliseconds
    });
    this.timer = this.setTimer(() => {
      this.timer = null;
      return this.attempt();
    }, milliseconds);
  }

  async attempt() {
    if (this.destroyed || !this.enabled || this.manualPaused || this.running || this.isConnected()) return false;
    if (this.isBusy()) {
      this.schedule(this.intervalSeconds * 1000);
      return false;
    }

    this.running = true;
    this.publish({ state:"connecting", manual:false, nextAttemptAt:null });
    // 每轮固定 USB 优先；USB 模式不可用时再扫描蓝牙 GATT。
    const transports = ["usb", "ble"];
    try {
      for (const transport of transports) {
        if (this.destroyed || !this.enabled || this.manualPaused || this.isConnected()) return false;
        try {
          const status = transport === "usb"
            ? await this.restoreUsb()
            : await this.restoreBle();
          if (this.destroyed || !this.enabled || this.manualPaused) {
            if (status?.state === "connected") {
              await Promise.resolve(transport === "usb" ? this.disconnectUsb() : this.disconnectBle()).catch(() => {});
            }
            if (!this.destroyed) {
              this.publish({
                state:this.enabled ? "paused" : "disabled",
                nextAttemptAt:null
              });
            }
            return false;
          }
          if (status?.state === "connected" || this.isConnected()) {
            this.lastTransport = transport;
            this.onConnected(transport);
            this.notifyConnected(transport);
            return true;
          }
        } catch {
          // 自动连接失败不打扰用户，下一轮按设置的间隔继续尝试。
        }
      }
      return false;
    } finally {
      this.running = false;
      const retryImmediately = this.immediateRetryPending;
      this.immediateRetryPending = false;
      if (!this.destroyed && this.enabled && !this.manualPaused && !this.isConnected()) {
        this.schedule(retryImmediately ? 0 : this.intervalSeconds * 1000, retryImmediately);
      }
    }
  }

  publish(patch) {
    this.onState({
      state:"idle",
      intervalSeconds:this.intervalSeconds,
      nextAttemptAt:null,
      ...patch
    });
  }
}

