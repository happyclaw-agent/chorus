from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def _run_cli_probe(tmp_path: Path, *, data_dir: str, arguments: list[str]) -> dict:
    script = """
import json
import os
import sys

import chorus.cli as cli

observed = {}
app = object()

def create_app(data_dir):
    observed["data_dir"] = data_dir
    return app

def run(received_app, **kwargs):
    assert received_app is app
    observed.update(kwargs)

cli.create_app = create_app
cli.uvicorn.run = run
sys.argv = ["chorus", *json.loads(os.environ["CHORUS_TEST_ARGUMENTS"])]
cli.main()
print(json.dumps(observed))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env={
            **os.environ,
            "CHORUS_DATA_DIR": data_dir,
            "CHORUS_TEST_ARGUMENTS": json.dumps(arguments),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_cli_uses_environment_data_dir_when_flag_is_omitted(tmp_path):
    configured = str(tmp_path / "from-environment")

    observed = _run_cli_probe(tmp_path, data_dir=configured, arguments=[])

    assert observed == {
        "data_dir": configured,
        "host": "127.0.0.1",
        "port": 8010,
    }


def test_cli_explicit_data_dir_overrides_environment(tmp_path):
    configured = str(tmp_path / "from-environment")
    explicit = str(tmp_path / "from-flag")

    observed = _run_cli_probe(
        tmp_path,
        data_dir=configured,
        arguments=["--data-dir", explicit],
    )

    assert observed["data_dir"] == explicit
