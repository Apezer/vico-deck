const { execFile } = require("child_process");
const os = require("os");

function cpuTotals() {
  return os.cpus().reduce((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    result.total += total;
    result.idle += cpu.times.idle;
    return result;
  }, { total:0, idle:0 });
}

function cpuUsage(previous, current) {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

function readGpuUsage() {
  if (process.platform !== "win32") return Promise.resolve(null);
  const command = [
    "$items=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue",
    "$value=($items|Where-Object {$_.Name -match 'engtype_3D'}|Measure-Object UtilizationPercentage -Sum).Sum",
    "if($null -eq $value){''}else{[Math]::Min(100,[Math]::Round($value))}"
  ].join(";");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      timeout: 1800
    }, (error, stdout) => {
      const text = String(stdout || "").trim();
      const value = Number(text);
      resolve(!error && text !== "" && Number.isFinite(value) ? value : null);
    });
  });
}

/** 启动轻量系统监控；CPU/内存每秒更新，GPU 每两秒尽力采集一次。 */
function startSystemMonitor(onStatus, intervalMs = 1000) {
  let previousCpu = cpuTotals();
  let gpu = null;
  let gpuReading = false;
  let tickCount = 0;

  const tick = () => {
    const currentCpu = cpuTotals();
    const cpu = cpuUsage(previousCpu, currentCpu);
    previousCpu = currentCpu;
    const totalMemory = os.totalmem();
    const memory = totalMemory > 0 ? (1 - os.freemem() / totalMemory) * 100 : 0;

    onStatus({
      cpu,
      gpu,
      memory,
      temperature:null,
      online:true,
      updatedAt:Date.now()
    });

    tickCount += 1;
    if (tickCount % 2 === 1 && !gpuReading) {
      gpuReading = true;
      readGpuUsage().then((value) => { gpu = value; }).finally(() => { gpuReading = false; });
    }
  };

  tick();
  const timer = setInterval(tick, Math.max(500, intervalMs));
  timer.unref?.();
  return { close: () => clearInterval(timer) };
}

module.exports = { cpuUsage, startSystemMonitor };
