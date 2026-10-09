# Vico 语音传输协议

键盘上的 INMP441 使用 16 kHz、16-bit、单声道 PCM。旋钮按下开始录音，松开
停止。USB 使用 32 KB 内部 RAM 环形缓冲，BLE 使用 512 KB PSRAM 环形缓冲，
采样期间同时经 USB Vendor HID 或 Vico BLE GATT TX 特征发送。语音会话独占设备
数据通道，普通按键、OLED 数字孪生、RGB、预设和状态同步会在结束包发出后恢复。

## 通用语音包

USB 使用 Vendor 命令 `0x94` 承载语音包；BLE 直接通知同一份语音包。所有多字节
整数均为小端序。

| 偏移 | 字段 | 说明 |
| --- | --- | --- |
| 0 | Magic | `0xA6` |
| 1 | Version | `2` |
| 2 | Type | 包类型 |
| 3～4 | Session ID | 一次录音的会话号 |

包类型：

- `1 RECORDING_STARTED`：采样率、最大录音秒数和 PCM 编码编号。
- `2 RECORDING_STOPPED`：最终 PCM 字节数、CRC32 和采样率。
- `3 AUDIO_CHUNK`：绝对字节偏移和连续 PCM 数据。
- `4 TRANSFER_END`：总字节数和 CRC32。
- `5 ERROR`：错误码 `1` 为麦克风不可用，`2` 为缓冲区溢出，`3` 为接收端不可用，
  `4` 为 PSRAM 初始化或语音缓冲区分配失败。

软件在开始包到达后预留最大录音空间，并在录音期间实时接收分片。结束包的长度和
CRC32 都通过后，软件才生成标准 PCM WAV 并提交豆包 Seed-ASR 2.0。BLE 连接时，
运行时包类型 `9` 用来声明软件正在监听语音通知，防止 GATT 页面手动断开后固件
误发送录音。BLE 每包大小取实际协商 MTU，固件首选 247 MTU 和低延迟连接参数。
