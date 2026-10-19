#!/usr/bin/env bash
# AgenticX Ontology CLI 一键安装脚本
# 用法: curl -sSL https://raw.githubusercontent.com/dubianche123/agenticx-agent-workbench/main/install.sh | bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${BOLD}[AgenticX Ontology]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
die()     { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# `install.sh` is also shipped alongside release artifacts. A release can put
# all Python wheels in a `wheelhouse/` directory so this path never reaches a
# package index. The normal path remains online for the curl installer.
OFFLINE_INSTALL="${AGX_OFFLINE_INSTALL:-${AGX_NO_NETWORK:-0}}"
WHEELHOUSE="${AGX_BACKEND_WHEELHOUSE:-${AGX_WHEELHOUSE:-}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline)
      OFFLINE_INSTALL=1
      shift
      ;;
    --wheelhouse)
      [[ $# -ge 2 ]] || die "--wheelhouse 需要一个目录路径"
      WHEELHOUSE="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
用法：install.sh [--offline [--wheelhouse DIR]]

在线安装默认从 PyPI 获取 agenticx[desktop-runtime]。
离线安装需要一个包含 agenticx 及其 desktop-runtime 依赖 wheels 的 wheelhouse；
也可以通过 AGX_BACKEND_WHEELHOUSE 指定目录。
USAGE
      exit 0
      ;;
    *)
      die "未知参数：$1（使用 --help 查看用法）"
      ;;
  esac
done

if [[ "$OFFLINE_INSTALL" == "1" || "$OFFLINE_INSTALL" == "true" || "$OFFLINE_INSTALL" == "yes" || "$OFFLINE_INSTALL" == "on" ]]; then
  OFFLINE_INSTALL=1
else
  OFFLINE_INSTALL=0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$WHEELHOUSE" ]]; then
  for candidate in "$SCRIPT_DIR/wheelhouse" "$SCRIPT_DIR/packaging/wheelhouse" "$PWD/packaging/wheelhouse" "$PWD/wheelhouse"; do
    [[ -d "$candidate" ]] || continue
    for archive in "$candidate"/*.whl "$candidate"/*.zip "$candidate"/*.tar.gz; do
      if [[ -f "$archive" ]]; then
        WHEELHOUSE="$candidate"
        break 2
      fi
    done
  done
fi

if [[ "$OFFLINE_INSTALL" == "1" ]]; then
  [[ -n "$WHEELHOUSE" && -d "$WHEELHOUSE" ]] || die "离线安装需要 wheelhouse 目录。请使用 --wheelhouse DIR，或让 Agent 配置 AGX_BACKEND_WHEELHOUSE。"
  has_wheel=0
  for archive in "$WHEELHOUSE"/*.whl "$WHEELHOUSE"/*.zip "$WHEELHOUSE"/*.tar.gz; do
    if [[ -f "$archive" ]]; then has_wheel=1; break; fi
  done
  [[ "$has_wheel" == "1" ]] || die "wheelhouse 为空：至少需要 agenticx 及 desktop-runtime 依赖的 wheel。"
  info "使用离线 wheelhouse 安装：$WHEELHOUSE"
fi

info "开始安装 AgenticX CLI (agx)..."
echo ""

# ── 1. 检测 Python ──────────────────────────────────────────────
PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    VER=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    MAJOR="${VER%%.*}"
    MINOR="${VER#*.}"
    if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 10 ]; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  die "未找到 Python 3.10+。\n请先安装 Python：https://www.python.org/downloads/\n或使用 Homebrew：brew install python@3.11"
fi

PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')")
success "检测到 Python ${PY_VERSION} (${PYTHON})"

# ── 2. 安装 agenticx ─────────────────────────────────────────────
# 默认安装 desktop-runtime extras，确保知识库（chromadb/onnxruntime）、
# PDF/Office 解析等桌面运行时依赖一次装齐，避免上传资料时报 "chromadb is required"。
info "安装 agenticx 包（含知识库/文档运行时依赖）..."
if [[ "$OFFLINE_INSTALL" == "1" ]]; then
  PIP_ARGS=(install --upgrade --no-cache-dir --no-index --find-links "$WHEELHOUSE" --prefer-binary "agenticx[desktop-runtime]")
else
  PIP_ARGS=(install --upgrade --prefer-binary "agenticx[desktop-runtime]")
fi
if "$PYTHON" -m pip "${PIP_ARGS[@]}" -q; then
  success "agenticx 安装成功"
else
  if [[ "$OFFLINE_INSTALL" == "1" ]]; then
    warn "离线 wheelhouse 安装失败，未尝试访问网络。"
    die "请让 Agent 补齐 wheelhouse 中的 agenticx[desktop-runtime] 依赖后重试。"
  fi
  warn "pip 直接安装失败，尝试 --user 模式..."
  USER_PIP_ARGS=(install --user --upgrade --prefer-binary "agenticx[desktop-runtime]")
  "$PYTHON" -m pip "${USER_PIP_ARGS[@]}" -q \
    || die "安装失败，请尝试手动运行：$PYTHON -m pip install 'agenticx[desktop-runtime]'"
fi

# ── 3. 确认 agx 命令可用 ──────────────────────────────────────────
AGX_PATH=$(command -v agx 2>/dev/null || "$PYTHON" -m pip show agenticx 2>/dev/null | grep -i "^Location" | awk '{print $2}' | xargs -I{} echo "{}/../../../bin/agx" || echo "")

if command -v agx &>/dev/null; then
  AGX_VER=$(agx --version 2>/dev/null || echo "unknown")
  success "agx 命令可用: ${AGX_VER}"
else
  # 常见 --user 安装路径
  USER_BIN="$HOME/.local/bin"
  if [[ "$PATH" != *"$USER_BIN"* ]]; then
    warn "agx 命令未在 PATH 中找到。"
    echo ""
    echo "  请将以下内容添加到 ~/.zshrc 或 ~/.bash_profile，然后重启终端："
    echo ""
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "  或直接运行："
    echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  else
    warn "agx 安装完成但未能直接调用，请重启终端后再试。"
  fi
fi

echo ""
info "安装完成！重新打开 AgenticX Ontology 即可使用。"
info "如有问题，请访问：https://github.com/dubianche123/agenticx-agent-workbench"
