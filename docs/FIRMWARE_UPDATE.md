# VicoDeck 固件升级

VicoDeck 使用 Electron 的 Web Serial 接口和 Espressif 官方 `esptool-js`，直接通过
USB 向 ESP32-S3 ROM Download Mode 写入固件。用户不需要安装 Python、PlatformIO
或单独的烧录程序。

## 用户流程

1. 在左侧打开“固件升级”。
2. 默认使用“云端固件”，从下拉框选择版本；云端目录会直接定义本次需要写入的镜像。
3. 需要使用自己的文件时切换到“本地 BIN 文件”，再选择“快速升级”或“完整烧录”。
4. 将键盘模式拨片切换到蓝牙侧，避免 USB HID 占用升级端口。
5. 使用支持数据传输的 USB 线连接键盘。
6. 点击升级按钮，选择 ESP32-S3 下载端口。
7. 只有自动进入下载模式失败时，才需要按住 `BOOT`、短按 `RST`，然后松开 `BOOT` 重试。
8. 等待写入、设备端 MD5 校验和自动重启完成。

本地快速升级直接选择一个应用固件 `.bin` 文件，并将其写入 `0x10000`。本地完整烧录
要求所选文件夹包含 `bootloader.bin`、`partitions.bin`、`boot_app0.bin` 和 `firmware.bin`。
软件会使用与 PlatformIO 相同的地址布局，并在打开串口前检查文件大小、ESP 镜像结构
以及 bootloader 和应用镜像的内部 SHA-256。

VicoDeck 的串口选择器只显示 USB VID 为 Espressif 或 Vico 的设备；建立连接后还会
读取芯片型号，只有 `ESP32-S3` 可以继续写入。

## 发布包结构

每个版本沿用 PlatformIO 的分段烧录方式：

| 镜像 | Flash 地址 |
| --- | ---: |
| `bootloader.bin` | `0x0000` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xE000` |
| `firmware.bin` | `0x10000` |

这种方式不会写入 `0x9000` 开始的 NVS 分区，因此升级后会保留按键预设、RGB、OLED
等用户设置。不要把带 `0xFF` 间隙的完整合并镜像直接写入 `0x0`，否则 NVS 会被覆盖。

内置固件目录位于 `firmware/catalog.json`。每项固件使用独立 `id` 标识，因此标准
键盘、小游戏等不同功能的固件可以拥有相同版本号。每个镜像都必须记录准确的字节数与
SHA-256；VicoDeck 在打开串口前完成完整性校验，烧录后再通过 ESP32-S3 ROM/stub
读取 MD5 进行第二次校验。

发布镜像中的 Flash 模式、频率和容量参数是最终值。VicoDeck 写入时统一使用 `keep`，
不会在浏览器中修改 bootloader 头部；这是为了确保 bootloader 内部附带的 SHA-256
摘要始终与实际写入内容一致。发布前还会解析并验证该内部摘要。

## 在线固件目录

应用优先读取：

```text
https://update.zheng2005.xyz/firmware/catalog.json
```

服务器不可用或目录无效时自动回退到安装包中的离线版本。在线目录沿用相同 JSON
结构；镜像可使用绝对 HTTPS `url`，也可使用相对于 `catalog.json` 的 `file` 路径。

发布新的固件版本时：

1. 修改固件的 `src/firmware_version.h`。
2. 使用 PlatformIO 重新构建。
3. 保存上述四个 `.bin` 文件并计算 SHA-256；不要在加入目录后再次修改镜像头部。
4. 将版本加入 `firmware/catalog.json`，新版本放在列表最前面。
5. 先上传所有镜像，再最后上传服务器 `catalog.json`，避免客户端发现尚未上传完整的版本。

## 当前内置版本

- `1.0.0`：Vico Keyboard 首个正式固件版本。
