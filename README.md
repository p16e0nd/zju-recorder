# ZJU Recorder

Windows 本地工具，用于查看与录制已获授权访问的智云课堂直播。HTTP 服务仅监听 `127.0.0.1`。

## 运行

1. 安装 Node.js 18+，或将便携版放到 `runtime/node/node.exe`。
2. 双击 `download-ffmpeg.bat` 安装 ffmpeg。
3. 双击 `start.bat`，浏览器将打开 `http://127.0.0.1:8787`。
4. 在设置中填入 JWT，或配置学号与密码用于自动登录。
5. 双击 `stop.bat` 停止服务。

录像默认保存到 `%USERPROFILE%\ZJU-Recordings\<课程_机位>\<日期>\`，每 30 分钟分段一次。

## 功能

- 直播查看、多机位切换与条件筛选。
- 手动录制、预约录制与断流重试。
- 可选本地 ASR 实时字幕；安装方法见 [`asr/README.md`](asr/README.md)。
- 可选手动同步第三方教评分数。
- 可选直播封面抓帧，默认关闭。

## 代码结构

```text
app/                    Node.js 服务端与静态前端
asr/                    可选本地语音识别 sidecar
download-ffmpeg.bat     ffmpeg 安装脚本
start.bat / stop.bat    Windows 启停入口
```

环境变量见 [`.env.example`](.env.example)。本地敏感文件、安全边界与漏洞报告方式见 [`SECURITY.md`](SECURITY.md)。使用限制见 [`DISCLAIMER.md`](DISCLAIMER.md)。
