"""Command-line entry point for the local Chorus server."""

from __future__ import annotations

import argparse

import uvicorn

from chorus.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Chorus OTLP quality server")
    parser.add_argument("--data-dir", default=".chorus")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    args = parser.parse_args()
    uvicorn.run(create_app(args.data_dir), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
