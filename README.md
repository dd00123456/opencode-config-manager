# OpenCode Config Manager

Small Electron app for managing OpenCode provider profiles (base URL + API key + models) and syncing them into OpenCode's global config and credentials.

## What it does

- Save multiple provider profiles and activate one with a click
- Write OpenCode global config (JSON/JSONC) under `~/.config/opencode/`
- Write OpenCode credentials under `~/.local/share/opencode/auth.json`
- Fetch provider-supported models from an OpenAI-compatible `/models` endpoint and let you pick models in the UI

## Requirements

- Node.js + npm
- OpenCode installed and available on PATH (`opencode --version`)

## Run (dev)

```bash
npm install
npm run start
```

## Build

```bash
npm run build:win
```

The unpacked Windows build is produced under `dist/win-unpacked/`.

## Notes

- OpenCode does not hot-reload config; fully restart OpenCode to see config changes.
- API keys are stored locally (OpenCode `auth.json` + this app's local store). Treat the machine/user account as the security boundary.
