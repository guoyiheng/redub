#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON="${REDUB_PYTHON:-python3.11}"
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r scripts/requirements.txt
printf '\n模型运行环境已安装。首次处理时会下载模型，请保持网络连接。\n'
