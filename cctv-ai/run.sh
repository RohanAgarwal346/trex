#!/usr/bin/env bash
# Drishti AI launcher.  Usage: ./run.sh   (then open http://localhost:8800)
cd "$(dirname "$0")"
pip install -q -r requirements.txt
HOST="${DRISHTI_HOST:-127.0.0.1}"   # set DRISHTI_HOST=0.0.0.0 to open on your LAN (set a PIN first!)
exec python3 -m uvicorn server.main:app --host "$HOST" --port "${DRISHTI_PORT:-8800}"
