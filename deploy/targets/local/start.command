#!/usr/bin/env bash
# Double-click to start this company on a Mac. It runs start.sh in this folder, and keeps the window open.
cd "$(dirname "$0")" && ./start.sh
printf '\nYou can close this window; the copy keeps running in Docker Desktop.\n'
read -r -p 'Press Return to close. ' _
