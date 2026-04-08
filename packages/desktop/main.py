#!/usr/bin/env python3
"""
heed — Floating Panel
A small always-on-top draggable panel for meeting transcription.
Wraps the heed web app and adds system audio capture via PipeWire.

Usage: python3 panel.py
"""
import subprocess
import sys
import os
import time
import signal
import threading

APP_URL = "http://localhost:5001"
SERVER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.ts")

server_proc = None


def start_server():
    """Start the Bun web server if not already running."""
    global server_proc
    import urllib.request
    try:
        urllib.request.urlopen(APP_URL, timeout=2)
        print("[heed] Server already running")
        return
    except Exception:
        pass

    print("[heed] Starting server...")
    server_proc = subprocess.Popen(
        ["bun", "run", SERVER_SCRIPT],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    # Wait for server to be ready
    for _ in range(20):
        try:
            urllib.request.urlopen(APP_URL, timeout=1)
            print("[heed] Server ready")
            return
        except Exception:
            time.sleep(0.5)
    print("[heed] Warning: server may not be ready")


def start_ollama():
    """Start Ollama if not running."""
    try:
        import urllib.request
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
        return
    except Exception:
        pass
    print("[heed] Starting Ollama...")
    subprocess.Popen(
        ["ollama", "serve"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(2)


def cleanup(*args):
    """Kill server on exit."""
    if server_proc:
        server_proc.terminate()
    sys.exit(0)


def main():
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    start_ollama()
    start_server()

    import webview

    window = webview.create_window(
        "heed",
        APP_URL,
        width=420,
        height=680,
        resizable=True,
        on_top=True,
        frameless=False,
        easy_drag=True,
        background_color="#F8FAFC",
        text_select=True,
    )

    webview.start(debug=False)
    cleanup()


if __name__ == "__main__":
    main()
