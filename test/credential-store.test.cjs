const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { CredentialStore } = require("../electron/credential-store.cjs");

test("API Key 只以加密字节保存", async (context) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "vico-key-test-"));
  context.after(() => fsp.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "key.bin");
  const safeStorage = {
    isEncryptionAvailable:() => true,
    encryptString:(value) => Buffer.from(`encrypted:${value}`, "utf8").reverse(),
    decryptString:(value) => Buffer.from(value).reverse().toString("utf8").slice(10)
  };
  const store = new CredentialStore(file, safeStorage);
  store.save("abcd-very-secret-xyz9");
  assert.equal(store.get(), "abcd-very-secret-xyz9");
  assert.doesNotMatch(fs.readFileSync(file).toString("utf8"), /very-secret/);
  assert.equal(store.info().masked, "abcd••••xyz9");
  store.clear();
  assert.equal(store.info().configured, false);
});
