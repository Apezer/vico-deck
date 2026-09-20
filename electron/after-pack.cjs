const path = require("node:path");

/**
 * Electron Builder 的完整 Windows 工具包包含 macOS 符号链接，在未开启
 * Windows 开发者模式的电脑上可能无法解压。这里使用项目依赖中的 rcedit
 * 直接写入应用图标和版本信息，使普通用户权限下的构建同样可复现。
 */
module.exports = async function applyWindowsExecutableResources(context) {
  if (context.electronPlatformName !== "win32") return;

  const { rcedit } = await import("rcedit");
  const appInfo = context.packager.appInfo;
  const executablePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "asserts", "vico-keyboard.ico");

  await rcedit(executablePath, {
    icon: iconPath,
    "file-version": appInfo.buildVersion,
    "product-version": appInfo.version,
    "version-string": {
      CompanyName: appInfo.companyName || "Vico",
      FileDescription: appInfo.description,
      ProductName: appInfo.productName,
      InternalName: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`
    }
  });
};
