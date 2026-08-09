const assert = require("node:assert/strict");
const { cpuUsage } = require("../electron/system-monitor.cjs");

assert.equal(cpuUsage({ total:100, idle:20 }, { total:200, idle:50 }), 70);
assert.equal(cpuUsage({ total:100, idle:20 }, { total:100, idle:20 }), 0);

console.log("System monitor passed: CPU delta calculation");
