#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON="${REDUB_PYTHON:-python3.11}"
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
if [ "${REDUB_CUDA:-0}" = "1" ]; then
  .venv/bin/python -m pip install --extra-index-url https://download.pytorch.org/whl/cu124 -r scripts/requirements.txt nvidia-cublas-cu12 nvidia-cudnn-cu12
else
  .venv/bin/python -m pip install -r scripts/requirements.txt
fi
printf '\n模型运行环境已安装。首次处理时会下载模型，请保持网络连接。\n'
