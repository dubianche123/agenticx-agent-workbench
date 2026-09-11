"""Read/write $AGX_HOME/automation_tasks.json — shared with Desktop AutomationScheduler.

This module provides the Python-side bridge so that ``schedule_task`` and
related meta tools can persist automation tasks to the same JSON file that the
Electron main process reads every 30 s in its ``AutomationScheduler.tick()``.

Workspace convention (must match Desktop ``save-automation-task``):
  - If ``workspace`` is set on the task → that directory is the task root (venv
    at ``<root>/.venv``, scripts under that tree).
  - If omitted → default ``$AGX_HOME/crontask/<task_id>/`` (one folder per task).
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from agenticx.utils.agx_home import agx_home

logger = logging.getLogger(__name__)

def _config_dir() -> Path:
    return agx_home()


def _tasks_path() -> Path:
    return _config_dir() / "automation_tasks.json"


def generate_task_id() -> str:
    ts = int(time.time() * 1000)
    import random
    suffix = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=6))
    return f"atask_{ts:x}_{suffix}"


def load_automation_tasks() -> List[Dict[str, Any]]:
    tasks_path = _tasks_path()
    try:
        if not tasks_path.exists():
            return []
        raw = tasks_path.read_text("utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        logger.warning("Failed to read %s", tasks_path, exc_info=True)
        return []


def save_automation_tasks(tasks: List[Dict[str, Any]]) -> None:
    config_dir = _config_dir()
    tasks_path = _tasks_path()
    config_dir.mkdir(parents=True, exist_ok=True)
    tmp = tasks_path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), "utf-8")
        os.replace(str(tmp), str(tasks_path))
    except Exception:
        logger.error("Failed to write %s", tasks_path, exc_info=True)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
