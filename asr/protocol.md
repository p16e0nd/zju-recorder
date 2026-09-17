# zju-asr-worker 协议 v1（JSONL over stdio）

Node 侧解析器与 worker 实现共用的通信契约。

## 1. 传输

| | |
|---|---|
| worker **stdin** | 原始 PCM：`f32le`（32 位小端 float，范围 -1..1），单声道，16000 Hz。**没有包头、没有分帧标记**，纯字节流。 |
| worker **stdout** | 协议事件，每行一个 UTF-8 JSON object，`\n` 结尾。**只放协议事件**，不放人读日志。 |
| worker **stderr** | 人读诊断与异常回溯，UTF-8，可以随便刷（Node 侧有环形缓冲上限）。 |

- 一行最大 **64 KiB**；超长行 Node 直接判为 protocol error。
- JSON 必须是 UTF-8；非 UTF-8 字节序列视为 protocol error。
- `seq` 从 1 开始严格递增（见 §4）。

启动命令（Node 侧固定，不接受浏览器输入）：

```text
<venv-python> -I -u asr/worker.py --profile streaming-zh --sample-rate 16000 --input-format f32le
```

## 2. 事件类型

所有事件都带 `"v": 1`（协议版本）。`v != 1` 立即拒绝。

```json
{"v":1,"type":"ready","model":"streaming-zh","sampleRate":16000,"chunkMs":100,"threads":2}
{"v":1,"type":"partial","seq":14,"text":"状态空间方程","audioMs":8420}
{"v":1,"type":"final","seq":15,"segment":3,"text":"状态空间方程。","t0Ms":6350,"t1Ms":9100}
{"v":1,"type":"metric","rtf":0.31,"queueMs":80,"rssMb":612,"audioMs":30000}
{"v":1,"type":"error","code":"MODEL_LOAD_FAILED","recoverable":false,"message":"..."}
{"v":1,"type":"stopped","reason":"eof","segments":12,"audioMs":45000}
```

| type | 何时发 | 关键字段 |
|---|---|---|
| `ready` | 模型加载完成、可以接受 PCM 时 | `model` `sampleRate` `chunkMs` `threads` |
| `partial` | 当前暂存文本**有变化**时（不是每个 chunk 都发） | `seq` `text` `audioMs` |
| `final` | endpoint（停顿）判定后，把暂存文本固化 | `seq` `segment` `text` `t0Ms` `t1Ms` |
| `metric` | 每 `--metric-ms`（默认 5000ms）一次 | `rtf` `queueMs` `rssMb` `audioMs` |
| `error` | 出错 | `code` `recoverable` `message` |
| `stopped` | 收尾完成、即将退出前**最后一条** | `reason` `segments` `audioMs` |

`error.code` 取值：`MODEL_LOAD_FAILED` / `MODEL_FILES_MISSING` / `BAD_INPUT_FORMAT` / `AUDIO_READ_ERROR` / `INFERENCE_ERROR` / `PROTOCOL_ERROR` / `INTERNAL`。

## 3. 字段约束

- `text`：最长 **8192 Unicode code point**，超长截断并在 stderr 记一条。不含换行（换行会让 JSONL 断行，直接替换成空格）。
- `audioMs` / `t0Ms` / `t1Ms`：毫秒整数，相对**本次 session 开始**。
- `segment`：final 从 1 开始递增。
- `rtf`：实时率 = 已耗 CPU 推理时间 / 已处理音频时长。
- `rssMb`：worker 自身常驻内存 MB。
- 未知字段：Node **忽略**。未知 `type`：计入 protocol error 并记录，不崩。

## 4. seq 与文本语义

- `seq` 只对 `partial` 和 `final` 计数，从 1 开始严格递增，中间不跳号。
- Node 侧遇到**重复或倒序** `seq`：丢弃该事件并记一条 diagnostic，不算致命。
- `partial` 的语义是**替换**当前暂存文本（不是追加）。
- `final` 的语义是**追加**到 segment 列表，同时清空暂存区。
- 一次 endpoint 后：**该段出过识别文本**就发 `final`（`text` 可能为空——出过 partial 但被
  后续静音清空，这时发空 `final` 保证不丢边界）；**该段从头到尾没出过任何文本**（纯静音，
  例如录音开头的空档）则**不发**任何事件，避免刷屏。
- `final` 的 `t0Ms` 是该段语音起点、`t1Ms` 是 endpoint 判定点；两者都由 worker 侧的
  音频时钟给出，**不是逐词精确对齐**。

## 5. 停止

**主路径是 stdin EOF**：Node 关闭 ffmpeg→worker 的 PCM 管道即表示"输入结束"。worker 收到 EOF 后：

1. 把剩余缓冲喂完、`input_finished()`，做最后一次 decode；
2. 若暂存区非空，发一条 `final`（收尾不丢字）；
3. 发 `{"type":"stopped","reason":"eof",...}`，退出码 0。

**辅助路径**：
- `reason:"signal"` —— 收到 SIGINT/SIGTERM（**仅 Unix 会到**）；
- `reason:"max-duration"` —— 达到 `--max-session-sec` 自停；
- `reason:"error"` —— 致命错误后收尾。

Windows 上不依赖 SIGINT/SIGTERM：Node 的 `proc.kill()` 底层是
`TerminateProcess`（等价强杀），worker 收不到任何信号，也就没有 flush 的机会。
强制结束不会执行 worker 收尾逻辑。Node 侧顺序为：**先关 stdin → 等 `stopped` → 超时未退才 kill**。

## 6. 资源约束（实现侧必须遵守）

- inference chunk 固定；VAD/endpoint 环形缓冲最多 30 秒；
- 单段语音硬上限 30 秒，超限强制 endpoint；
- transcript segment 内存最多 10000 条，超出淘汰最早的（worker 只保留计数与最近窗口，落盘由 Node 决定）；
- **不建立无界队列**：PCM 读完即用；读得比推理快时，靠 Node 侧 stream backpressure（`ffmpeg.stdout.pipe(worker.stdin)`）自然阻塞，worker 自己不做无限缓存；
- stderr 在 Node 侧保留最多 256 KiB 环形缓冲。
- 连续 **10 秒**既没有消费 PCM 也没有心跳 → Node 判定 worker hung。

## 7. 心跳

即使上游静音、没有产生任何 `partial`，worker 也必须在 `--metric-ms` 周期内至少发一条
`metric`——这样 Node 才能区分"没说话"和"worker 卡死"。
