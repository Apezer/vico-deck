# VicoDeck BLE GATT 协议

Vico Keyboard 在标准蓝牙 HID 键盘服务之外，提供一组用于 OLED 运行时状态的
自定义 GATT 服务。电脑可以保持键盘输入连接，同时通过该服务发送 Claude Code、
系统监控、时间和页面设置。

## UUID

| 名称 | UUID | 属性 |
|---|---|---|
| 状态服务 | `7b6a0001-7c6e-4b3d-9f5f-7669636f0001` | 主服务 |
| RX | `7b6a0002-7c6e-4b3d-9f5f-7669636f0002` | Write、Write Without Response |
| TX | `7b6a0003-7c6e-4b3d-9f5f-7669636f0003` | Read、Notify |

## 状态写入

桌面软件通常向 RX 写入固定长度 32 字节运行时数据包。数据包包含魔数、协议版本、
包类型、状态负载和异或校验值。详细字段见
[OLED_RUNTIME_PROTOCOL.md](OLED_RUNTIME_PROTOCOL.md)。

为兼容 `esp32s3-BLE-GATT-test` 的调试脚本，RX 也接受紧凑 JSON：

```json
{"state":"tool","tool":"Bash","text":"Running pio run"}
```

JSON 写入成功后，TX 会通知 `{"ok":true,"state":"...","text":"..."}` ACK。
二进制协议用于完整的软件功能，JSON 格式便于脚本和 BLE 调试工具独立发送状态。

## 页面通知

用户在键盘设置菜单或使用 `Fn + KEY6 / KEY7` 切换页面后，固件通过 TX 发送
设置类型运行时数据包。软件据此更新页面选择，避免键盘和软件显示不同状态。

## 兼容性

蓝牙设备名称必须以 `Vico Keyboard` 开头。当前状态服务要求支持运行时协议的
新固件；旧固件不会提供该服务，软件会提示连接失败。字段名和 OLED Coding 页面布局
与参考项目保持一致。
