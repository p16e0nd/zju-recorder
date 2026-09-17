# asr —— 可选的本地实时字幕

把直播课的音频在本机转写成带时间戳的中文文字，显示在课程页右侧的「实时字幕」面板里。
识别完全在本机运行，音频不上传，运行时不联网。

## 安装（一次性）

需要 Python 3.12（在 PATH 里）与联网：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File asr\scripts\setup-windows.ps1
```

脚本做三件事：建虚拟环境、按 `requirements.lock` 安装依赖（带哈希校验）、
按 `models/manifest.json` 下载模型（带 SHA-256 校验）。
所有内容落在 `runtime\asr\`，不进 git，也不随仓库分发。

装完重启服务：`stop.bat` 再 `start.bat`。

## 使用

课程详情页 → 右侧「实时字幕」→ 开始识别。

- 面板顶部是状态与本次识别的信息，下面的字幕**最新的在最上面**
- 可以导出 TXT / SRT，或复制全文
- 不安装 ASR 也能正常使用其它功能，面板会说明缺少什么

音频在进程间以 s16le 传输，不落盘。实际磁盘、内存与延迟取决于模型和硬件。

模型许可见 `models/manifest.json` 的 `license` 字段（部分上游仓库未声明许可，安装脚本会提示）。

## 目录

```text
worker.py                  识别进程（消息协议见 protocol.md）
protocol.md                服务端 ↔ worker 的约定
models/manifest.json       模型清单（来源与校验和）
requirements.lock          依赖与哈希
scripts/setup-windows.ps1  一次性安装
```
