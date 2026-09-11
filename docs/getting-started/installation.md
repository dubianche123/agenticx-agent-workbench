# Installation

## Requirements

- Python 3.10+
- pip or uv

## Install from PyPI (Recommended)

For the Near desktop / knowledge-base experience, install the `desktop-runtime`
extras so the local backend ships with the vector store (chromadb/onnxruntime)
and PDF/Office parsing. Plain `pip install agenticx` does NOT include chromadb
and will raise `chromadb is required for the knowledge base` when ingesting docs.

```bash
pip install "agenticx[desktop-runtime]"
```

Minimal core CLI only (no knowledge base):

```bash
pip install agenticx
```

For all optional features (document parsing, vector stores, etc.):

```bash
pip install "agenticx[all]"
```

## Offline installation

The self-contained Desktop DMG/NSIS installers embed `agx-server` and do not
download Python or Node dependencies on first launch. For a CLI or a Desktop
checkout without an embedded backend, prepare a wheelhouse on a connected
machine and copy it with the installer:

```bash
# On a connected machine, download the package and its desktop runtime wheels.
python -m pip download --dest wheelhouse "agenticx[desktop-runtime]"

# On the offline machine, run the local copy of install.sh.
bash install.sh --offline --wheelhouse ./wheelhouse
```

The Desktop dependency repair follows the same rule: it uses a discovered
`packaging/wheelhouse` (or `AGX_BACKEND_WHEELHOUSE`) without contacting PyPI;
when no wheelhouse is present it reports that network access is required so an
Agent can add the missing artifact instead of leaving pip retrying in the
background.

## Install from Source

```bash
git clone https://github.com/dubianche123/Agenticx-ontology.git
cd Agenticx-ontology

# Desktop / knowledge-base runtime (recommended)
pip install -e ".[desktop-runtime]"

# Basic install (no knowledge base)
pip install -e .

# With all extras
pip install -e ".[all]"
```

## Environment Setup

```bash
# Required: at least one LLM provider key
export OPENAI_API_KEY="your-api-key"

# Optional providers
export ANTHROPIC_API_KEY="your-api-key"
export MOONSHOT_API_KEY="your-api-key"
```

Or use a `.env` file in your project root:

```bash
OPENAI_API_KEY=your-api-key
ANTHROPIC_API_KEY=your-api-key
```

## System Dependencies (Optional)

For advanced document processing features (PDF / Word / PPT parsing):

```bash
# macOS
brew install antiword tesseract

# Ubuntu/Debian
sudo apt-get install antiword tesseract-ocr
```

## Verify Installation

```bash
agx --version
```

You should see output like:

```
agx version 0.x.x
```

## Next Steps

- [Quick Start →](quickstart.md)
- [Configuration →](configuration.md)
