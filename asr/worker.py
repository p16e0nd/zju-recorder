#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zju-asr-worker —— 实时语音识别独立 worker（协议见 protocol.md）。
输入为 stdin PCM，输出为 stdout JSONL；运行时使用固定模型与参数，不访问网络。

进程边界上它刻意什么都不知道：
  * 不知道 URL、JWT、课程、浏览器请求；
  * 不联网（不下载模型、不 pip install、不做 marketplace 查询）；
  * 只读自己的模型目录，只写 stdout/stderr。

用法：
    <venv-python> -I -u asr/worker.py --profile streaming-zh
    <venv-python> -I -u asr/worker.py --profile streaming-zh --self-test
"""

import argparse
import ctypes
import io
import json
import os
import sys
import threading
import time
import hashlib

# ---------------------------------------------------------------------------
# 协议常量
# ---------------------------------------------------------------------------
PROTOCOL_VERSION = 1
MAX_TEXT_CODEPOINTS = 8192          # protocol.md §3
MAX_LINE_BYTES = 64 * 1024          # protocol.md §1
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_CHUNK_MS = 100
DEFAULT_METRIC_MS = 5000
DEFAULT_MAX_SEGMENT_SEC = 30.0      # protocol.md §6：单段硬上限
MAX_RECORDED_SEGMENTS = 10000       # protocol.md §6：内存里最多留这么多段

# 把 stderr 变成 UTF-8，避免 Windows 默认 GBK 控制台在打印中文路径时抛
# UnicodeEncodeError。
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg):
    """人读诊断一律走 stderr（stdout 只放协议）。"""
    try:
        sys.stderr.write("[worker] %s\n" % msg)
        sys.stderr.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 协议输出
# ---------------------------------------------------------------------------
class ProtocolWriter:
    """往 stdout 写 JSONL。显式用二进制缓冲 + UTF-8，绕开 Windows 的文本层编码。"""

    def __init__(self, stream=None):
        self._out = stream if stream is not None else sys.stdout.buffer
        self._seq = 0
        self._segments = 0
        self._lock = threading.Lock()

    @property
    def seq(self):
        return self._seq

    @property
    def segments(self):
        return self._segments

    def _emit(self, obj):
        obj = dict(obj)
        obj["v"] = PROTOCOL_VERSION
        # 先按协议顺序构造：v 放最前面只是可读性，JSON 本身无序
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        data = line.encode("utf-8")
        if len(data) > MAX_LINE_BYTES:
            # 协议要求一行 <= 64KiB；不该发生，真发生了宁可丢事件也不能发坏行
            log("丢弃超长事件 (%d bytes, type=%s)" % (len(data), obj.get("type")))
            return
        with self._lock:
            self._out.write(data + b"\n")
            self._out.flush()

    def _clean_text(self, text):
        t = "" if text is None else str(text)
        t = t.replace("\r", " ").replace("\n", " ")   # JSONL 不能断行
        if len(t) > MAX_TEXT_CODEPOINTS:
            log("文本超长，截断到 %d code point" % MAX_TEXT_CODEPOINTS)
            t = t[:MAX_TEXT_CODEPOINTS]
        return t

    def ready(self, model, sample_rate, chunk_ms, threads):
        self._emit({"type": "ready", "model": model, "sampleRate": sample_rate,
                    "chunkMs": chunk_ms, "threads": threads})

    def partial(self, text, audio_ms):
        self._seq += 1
        self._emit({"type": "partial", "seq": self._seq,
                    "text": self._clean_text(text), "audioMs": int(audio_ms)})

    def final(self, text, t0_ms, t1_ms):
        self._seq += 1
        self._segments += 1
        self._emit({"type": "final", "seq": self._seq, "segment": self._segments,
                    "text": self._clean_text(text),
                    "t0Ms": int(t0_ms), "t1Ms": int(t1_ms)})

    def metric(self, rtf, queue_ms, rss_mb, audio_ms):
        self._emit({"type": "metric", "rtf": round(float(rtf), 4),
                    "queueMs": int(queue_ms), "rssMb": rss_mb,
                    "audioMs": int(audio_ms)})

    def error(self, code, message, recoverable=False):
        self._emit({"type": "error", "code": code, "recoverable": bool(recoverable),
                    "message": str(message)[:1000]})

    def stopped(self, reason, audio_ms):
        self._emit({"type": "stopped", "reason": reason,
                    "segments": self._segments, "audioMs": int(audio_ms)})


# ---------------------------------------------------------------------------
# 资源观测
# ---------------------------------------------------------------------------
def rss_mb():
    """当前常驻内存 MB。Windows 用 GetProcessMemoryInfo，Unix 用 getrusage。"""
    try:
        if sys.platform == "win32":
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            # 必须显式声明 restype/argtypes：GetCurrentProcess 返回的是 64 位伪句柄
            # (HANDLE)-1，用默认的 c_int 会截断成无效句柄，调用直接报 ERROR_INVALID_HANDLE(6)。
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.GetCurrentProcess.argtypes = []
            get_mem = getattr(kernel32, "K32GetProcessMemoryInfo", None)
            if get_mem is not None:
                get_mem.restype = wintypes.BOOL
                get_mem.argtypes = [wintypes.HANDLE,
                                    ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
                                    wintypes.DWORD]
                counters = PROCESS_MEMORY_COUNTERS()
                counters.cb = ctypes.sizeof(counters)
                if get_mem(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                    return round(counters.WorkingSetSize / 1048576.0, 1)
        else:
            import resource
            raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # Linux/macOS 单位不同：Linux 是 KB，macOS 是字节
            return round(raw / 1048576.0 if sys.platform == "darwin" else raw / 1024.0, 1)
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# 模型清单 / profile
# ---------------------------------------------------------------------------
def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def manifest_path():
    return os.path.join(repo_root(), "asr", "models", "manifest.json")


def default_models_root():
    # 大文件不进 git：模型放 runtime/asr/models（runtime/ 已在 .gitignore 里）
    return os.path.join(repo_root(), "runtime", "asr", "models")


def load_manifest():
    try:
        with io.open(manifest_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        log("读不到 manifest（%s）：%s" % (manifest_path(), exc))
        return None


def sha256_file(path, block=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(block), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_profile(profile):
    """把 profile 名解析成 {kind, dir, files...}。"""
    manifest = load_manifest()
    if manifest is None:
        raise WorkerError("MODEL_FILES_MISSING", "找不到 asr/models/manifest.json")
    entry = (manifest.get("profiles") or {}).get(profile)
    if not entry:
        known = ", ".join(sorted((manifest.get("profiles") or {}).keys()))
        raise WorkerError("MODEL_FILES_MISSING",
                          "未知 profile %r（manifest 里只有：%s）" % (profile, known))

    model_dir = os.path.join(default_models_root(), entry.get("dir", profile))
    files = entry.get("files") or {}
    missing = []
    for name, meta in files.items():
        p = os.path.join(model_dir, name)
        if not os.path.isfile(p):
            missing.append(name)
    if missing:
        raise WorkerError("MODEL_FILES_MISSING",
                          "模型文件缺失：%s（目录 %s）" % (", ".join(missing), model_dir))

    for name, meta in files.items():
        want = (meta or {}).get("sha256")
        if not want or want.startswith("TODO"):
            continue
        got = sha256_file(os.path.join(model_dir, name))
        if got.lower() != want.lower():
            raise WorkerError("MODEL_LOAD_FAILED",
                              "SHA-256 不匹配：%s（期望 %s，实际 %s）" % (name, want[:16], got[:16]))

    return {"name": profile, "kind": entry.get("kind", "transducer"),
            "dir": model_dir, "files": files,
            "config": entry.get("config") or {}}


class WorkerError(Exception):
    def __init__(self, code, message, recoverable=False):
        super().__init__(message)
        self.code = code
        self.message = message      # 显式存一份：Exception 只把 message 放在 args[0]
        self.recoverable = recoverable


# ---------------------------------------------------------------------------
# 后端一：sherpa-onnx 流式识别
# ---------------------------------------------------------------------------
class SherpaBackend:
    """streaming transducer（Zipformer）/ paraformer 的流式识别后端。"""

    def __init__(self, resolved, sample_rate, threads, endpoint_rules):
        import sherpa_onnx

        self.sample_rate = sample_rate
        self.kind = resolved["kind"]
        d = resolved["dir"]
        cfg = resolved.get("config") or {}

        def f(name):
            return os.path.join(d, name)

        r1, r2, r3 = endpoint_rules
        common = dict(
            num_threads=threads,
            sample_rate=sample_rate,
            feature_dim=int(cfg.get("feature_dim", 80)),
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=float(cfg.get("rule1", r1)),
            rule2_min_trailing_silence=float(cfg.get("rule2", r2)),
            rule3_min_utterance_length=float(cfg.get("rule3", r3)),
            decoding_method="greedy_search",
            provider="cpu",
        )

        if self.kind == "transducer":
            self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=f("tokens.txt"),
                encoder=f(cfg.get("encoder", "encoder.int8.onnx")),
                decoder=f(cfg.get("decoder", "decoder.onnx")),
                joiner=f(cfg.get("joiner", "joiner.int8.onnx")),
                **common
            )
        elif self.kind == "paraformer":
            self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
                tokens=f("tokens.txt"),
                encoder=f(cfg.get("encoder", "encoder.int8.onnx")),
                decoder=f(cfg.get("decoder", "decoder.int8.onnx")),
                **common
            )
        else:
            raise WorkerError("MODEL_LOAD_FAILED", "不支持的模型类型：%s" % self.kind)

        self.stream = self.recognizer.create_stream()

    def accept(self, samples):
        self.stream.accept_waveform(self.sample_rate, samples)
        # 兼容 sherpa-onnx 的单流与多流解码 API。
        self._decode_ready()

    def _decode_ready(self):
        rec, stream = self.recognizer, self.stream
        one = getattr(rec, "decode_stream", None)
        many = getattr(rec, "decode_streams", None)
        while rec.is_ready(stream):
            if one is not None:
                one(stream)
            elif many is not None:
                many([stream])
            else:
                raise WorkerError("INTERNAL", "识别器既没有 decode_stream 也没有 decode_streams")

    def text(self):
        return self.recognizer.get_result(self.stream) or ""

    def is_endpoint(self):
        return bool(self.recognizer.is_endpoint(self.stream))

    def reset(self):
        self.recognizer.reset(self.stream)

    def finish(self):
        """输入结束：喂尾音并做最后一次 decode，避免最后一个字丢掉。"""
        try:
            self.stream.input_finished()
        except Exception:
            pass
        self._decode_ready()
        return self.text()


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
def make_backend(resolved, args):
    return SherpaBackend(
        resolved, args.sample_rate, args.threads,
        (args.rule1, args.rule2, args.rule3),
    )


def parse_args(argv):
    ap = argparse.ArgumentParser(description="zju-asr-worker (JSONL v1 over stdio)")
    ap.add_argument("--profile", required=True, help="模型 profile 名（见 asr/models/manifest.json）")
    ap.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    ap.add_argument("--input-format", default="f32le", choices=["f32le"])
    ap.add_argument("--chunk-ms", type=int, default=DEFAULT_CHUNK_MS)
    ap.add_argument("--metric-ms", type=int, default=DEFAULT_METRIC_MS)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--max-segment-sec", type=float, default=DEFAULT_MAX_SEGMENT_SEC)
    ap.add_argument("--max-session-sec", type=float, default=0.0, help="0=不限制")
    ap.add_argument("--rule1", type=float, default=2.4)
    ap.add_argument("--rule2", type=float, default=1.2)
    ap.add_argument("--rule3", type=float, default=20.0)
    ap.add_argument("--self-test", action="store_true", help="只加载后端并退出，用来验证环境")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)

    writer = ProtocolWriter()

    try:
        resolved = resolve_profile(args.profile)
        backend = make_backend(resolved, args)
    except WorkerError as exc:
        writer.error(exc.code, exc.message, exc.recoverable)
        return 2
    except Exception as exc:  # 模型加载失败的常见形态就是这里
        writer.error("MODEL_LOAD_FAILED", "%s: %s" % (type(exc).__name__, exc), False)
        return 2

    writer.ready(args.profile, args.sample_rate, args.chunk_ms, args.threads)

    if args.self_test:
        writer.stopped("self-test", 0)
        return 0

    bytes_per_chunk = int(args.sample_rate * (args.chunk_ms / 1000.0) * 4)
    if bytes_per_chunk <= 0:
        writer.error("BAD_INPUT_FORMAT", "chunk 大小算出来是 0")
        return 2

    try:
        import numpy as np
    except Exception as exc:
        writer.error("INTERNAL", "缺少 numpy：%s" % exc)
        return 2

    stdin = sys.stdin.buffer
    read = stdin.read
    pending = b""
    audio_ms = 0.0
    segment_start_ms = 0.0
    infer_seconds = 0.0
    stdin_wait_ms = 0
    last_partial = None
    segment_spoke = False          # 本段是否出过识别文本（决定 endpoint 要不要发 final）
    next_metric_at = time.monotonic() + args.metric_ms / 1000.0
    session_start = time.monotonic()
    stop_reason = None
    fatal = None

    while True:
        # --- 到达 session 上限就主动收尾 ---
        if args.max_session_sec and (time.monotonic() - session_start) >= args.max_session_sec:
            stop_reason = "max-duration"
            break

        t0 = time.monotonic()
        try:
            chunk = read(bytes_per_chunk)
        except Exception as exc:
            fatal = WorkerError("AUDIO_READ_ERROR", "读 stdin 失败：%s" % exc)
            break
        stdin_wait_ms += int((time.monotonic() - t0) * 1000)

        if not chunk:
            stop_reason = "eof"
            break

        pending += chunk
        # 只处理整块的样本，剩下的字节留到下一轮
        usable = len(pending) - (len(pending) % 4)
        if usable <= 0:
            continue
        raw, pending = pending[:usable], pending[usable:]
        samples = np.frombuffer(raw, dtype="<f4")
        if samples.size == 0:
            continue

        try:
            ti = time.monotonic()
            endpoint_hint = backend.accept(samples)
            infer_seconds += time.monotonic() - ti
        except WorkerError as exc:
            fatal = exc
            break
        except Exception as exc:
            fatal = WorkerError("INFERENCE_ERROR", "%s: %s" % (type(exc).__name__, exc))
            break

        audio_ms += (samples.size / float(args.sample_rate)) * 1000.0

        # --- partial：文本变了才发 ---
        try:
            current = backend.text()
        except Exception:
            current = ""
        if current and current != last_partial:
            writer.partial(current, audio_ms)
            last_partial = current
            segment_spoke = True

        # --- endpoint：假后端用返回值，真后端用 is_endpoint ---
        is_endpoint = (endpoint_hint == "endpoint")
        if not is_endpoint:
            try:
                is_endpoint = backend.is_endpoint()
            except Exception:
                is_endpoint = False

        # --- 单段硬上限：超了强制切，防止长句把内存拖住 ---
        if not is_endpoint and (audio_ms - segment_start_ms) >= args.max_segment_sec * 1000.0:
            is_endpoint = True

        if is_endpoint:
            # 只有这一段真的出过识别文本才发 final。纯静音段（例如录音开头的空档）
            # 不产生任何事件，否则每段静音都会塞一条空 final，把界面刷满空行。
            if current:
                writer.final(current, segment_start_ms, audio_ms)
            elif segment_spoke:
                writer.final("", segment_start_ms, audio_ms)
            backend.reset()
            last_partial = None
            segment_spoke = False
            segment_start_ms = audio_ms
        elif not current:
            segment_start_ms = audio_ms

        # --- 心跳：静音时也要有 metric，Node 才分得清"没说话"和"卡死" ---
        now = time.monotonic()
        if now >= next_metric_at:
            next_metric_at = now + args.metric_ms / 1000.0
            audio_seconds = audio_ms / 1000.0
            writer.metric(
                (infer_seconds / audio_seconds) if audio_seconds > 0 else 0.0,
                stdin_wait_ms, rss_mb(), audio_ms,
            )
            stdin_wait_ms = 0

    # ---------------- 收尾 ----------------
    if fatal is None:
        try:
            tail = backend.finish()
        except Exception as exc:
            tail = ""
            fatal = WorkerError("INFERENCE_ERROR", "收尾 decode 失败：%s" % exc)
        if tail:
            writer.final(tail, segment_start_ms, audio_ms)
            backend.reset()
    else:
        writer.error(fatal.code, fatal.message, fatal.recoverable)
        stop_reason = "error"

    # 只有真的处理过音频才发收尾 metric；空输入发一条 rtf=0/audioMs=0 没有信息量
    if audio_ms > 0:
        try:
            audio_seconds = audio_ms / 1000.0
            writer.metric((infer_seconds / audio_seconds) if audio_seconds > 0 else 0.0,
                          stdin_wait_ms, rss_mb(), audio_ms)
        except Exception:
            pass

    writer.stopped(stop_reason or "eof", audio_ms)
    return 0 if fatal is None else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # Unix 上收到 SIGINT：也走收尾（Windows 上收不到，见 protocol.md §5）
        try:
            ProtocolWriter().stopped("signal", 0)
        except Exception:
            pass
        sys.exit(130)
