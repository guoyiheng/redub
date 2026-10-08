# Windows PowerShell 自动安装模型运行环境（包含 CUDA 加速支持）
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$scriptDir\.."

$pythonCmd = if ($env:REDUB_PYTHON) { $env:REDUB_PYTHON } else { "python" }

Write-Host ">>> 正在创建 Python 虚拟环境 (.venv)..."
& $pythonCmd -m venv .venv

$venvPython = ".venv\Scripts\python.exe"

Write-Host ">>> 正在升级 pip..."
& $venvPython -m pip install --upgrade pip

Write-Host ">>> 正在安装依赖包（配置 PyTorch CUDA 与 NVIDIA 运行库）..."
& $venvPython -m pip install --extra-index-url https://download.pytorch.org/whl/cu124 -r scripts\requirements.txt nvidia-cublas-cu12 nvidia-cudnn-cu12

Write-Host "`n>>> 验证模型运行环境及硬件加速状态..."
& $venvPython -c "import demucs, faster_whisper, soundfile, opencc, torch; print('CUDA 是否可用:', torch.cuda.is_available()); print('显卡设备名称:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '无 (将使用 CPU)')"

Write-Host "`n>>> 模型运行环境安装完成。首次使用时会自动下载模型权重，请保持网络畅通。"
