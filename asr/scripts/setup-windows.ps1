# zju-asr-worker 安装脚本（Windows / PowerShell）
#
# 显式、离线可复现、fail-closed。**不在应用运行期间自动执行**：由用户手动跑一次。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File asr\scripts\setup-windows.ps1
#   powershell ... -File asr\scripts\setup-windows.ps1 -AsrProfile streaming-zh
#   powershell ... -File asr\scripts\setup-windows.ps1 -Verify      # 只校验，不下载
#
# 做三件事：
#   1. 建独立 venv（runtime\asr\venv），依赖按 asr\requirements.lock 的 hash 安装
#   2. 按 asr\models\manifest.json 下载模型到 runtime\asr\models\<dir>，逐个校验 SHA-256
#   3. 打印结果
#
# 安全边界：
#   * 不在运行期自动 pip install / 自动下载模型
#   * 不提供在线 marketplace / 动态插件 / 任意命令执行
#   * 不碰 JWT、credentials、stream cache、录像

param(
  [string]$AsrProfile = "streaming-zh",
  [switch]$Verify,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AsrDir   = Split-Path -Parent $PSScriptRoot          # ...\ZJU-Recorder\asr
$Root     = Split-Path -Parent $AsrDir                # ...\ZJU-Recorder
$VenvDir  = Join-Path $Root "runtime\asr\venv"
$ModelsDir= Join-Path $Root "runtime\asr\models"
$Lock     = Join-Path $AsrDir "requirements.lock"
$Manifest = Join-Path $AsrDir "models\manifest.json"

function Info($m) { Write-Host $m }
function Fail($m) { Write-Host "[ERROR] $m" -ForegroundColor Red; exit 1 }

# ---------- 0. 前置检查 ----------
if (-not (Test-Path -LiteralPath $Manifest)) { Fail "找不到模型清单：$Manifest" }
$manifestObj = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = $manifestObj.profiles.$AsrProfile
if (-not $entry) {
  $known = ($manifestObj.profiles.PSObject.Properties.Name) -join ", "
  Fail "manifest 里没有 profile '$AsrProfile'（只有：$known）"
}
Info "profile       : $AsrProfile"
Info "模型目录      : $ModelsDir\$($entry.dir)"
Info "venv          : $VenvDir"
Info ""

# 找 Python 3.12
$py = $null
foreach ($cand in @("python", "py")) {
  $cmd = Get-Command $cand -ErrorAction SilentlyContinue
  if ($cmd) {
    $v = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($v -eq "3.12") { $py = $cand; break }
  }
}
if (-not $py) { Fail "找不到 Python 3.12。requirements.lock 里的 wheel 是 cp312 的，换小版本必须重新生成哈希。" }
Info "python        : $py ($(& $py -c 'import sys;print(sys.version.split()[0])'))"

# ---------- 1. venv ----------
$venvPy = Join-Path $VenvDir "Scripts\python.exe"
if ($Verify) {
  if (-not (Test-Path -LiteralPath $venvPy)) { Fail "venv 不存在，先不带 -Verify 跑一次" }
} elseif (-not (Test-Path -LiteralPath $venvPy) -or $Force) {
  if ($Force -and (Test-Path -LiteralPath $VenvDir)) {
    Info "`n-Force：删除旧 venv $VenvDir"
    Remove-Item -LiteralPath $VenvDir -Recurse -Force
  }
  Info "`n[1/3] 建 venv ..."
  & $py -m venv $VenvDir
  if ($LASTEXITCODE -ne 0) { Fail "venv 创建失败" }
} else {
  Info "`n[1/3] venv 已存在，跳过（要重建加 -Force）"
}

# ---------- 2. 依赖（带 hash 校验） ----------
if (-not $Verify) {
  Info "`n[2/3] 安装依赖（--require-hashes，任何哈希不符都直接失败）..."
  & $venvPy -m pip install --disable-pip-version-check --no-input --require-hashes -r $Lock
  if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败（哈希校验不过或被网络拦住）" }
} else {
  Info "`n[2/3] -Verify：跳过安装"
}

# ---------- 3. 模型 ----------
Info "`n[3/3] 模型文件 ..."
$modelDir = Join-Path $ModelsDir $entry.dir
if (-not (Test-Path -LiteralPath $modelDir)) { New-Item -ItemType Directory -Path $modelDir -Force | Out-Null }

$tpl = $entry.source.urlTemplate
$bad = 0
foreach ($f in $entry.files.PSObject.Properties) {
  $name = $f.Name
  $want = $f.Value.sha256
  $dest = Join-Path $modelDir $name

  $need = $true
  $downloaded = $false
  if (Test-Path -LiteralPath $dest) {
    $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()
    if ($have -eq $want.ToLowerInvariant()) { $need = $false; Info "  [ok]   $name （哈希一致，跳过）" }
    else { Info "  [重下] $name （哈希不符：本地 $($have.Substring(0,12))… 期望 $($want.Substring(0,12))…）" }
  }

  if ($need -and -not $Verify) {
    $url = $tpl.Replace("{file}", $name)
    Info "  [下载] $name  <- $url"
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 1800
      $downloaded = $true
    } catch { Fail "下载失败：$name" }
  }

  # 只有真的下载过才再报一次结果；"哈希一致，跳过"上面那行已经说清楚了
  if ($downloaded) {
    $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()
    if ($have -ne $want.ToLowerInvariant()) {
      # fail closed：哈希不符就删掉，绝不留下一个"看着像能用"的模型
      Remove-Item -LiteralPath $dest -Force
      Write-Host "  [FAIL] $name 哈希不符，已删除" -ForegroundColor Red
      $bad++
    } else {
      Info "  [ok]   $name  $($have.Substring(0,16))…"
    }
  } elseif ($Verify -and -not (Test-Path -LiteralPath $dest)) {
    Write-Host "  [缺失] $name" -ForegroundColor Yellow
    $bad++
  }
}

if ($bad -gt 0) { Fail "$bad 个模型文件校验失败。ASR 不会启动（fail closed）。" }

# ---------- 收尾：自测 ----------
if (-not $Verify) {
  Info "`n自测（加载模型并退出）..."
  & $venvPy -I -u (Join-Path $AsrDir "worker.py") --profile $AsrProfile --self-test
  if ($LASTEXITCODE -ne 0) { Fail "worker 自测失败" }
}

Info ""
Info "安装与自测完成。"
if (-not $entry.license.declared) {
  Write-Host "`n注意：该模型的上游仓库**未声明许可证**（见 manifest.json 的 license 字段）。" -ForegroundColor Yellow
  Write-Host "自行使用前请确认模型权重的授权范围。" -ForegroundColor Yellow
}
