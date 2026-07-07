# Harness Code

Your own agentic coding assistant, on the desktop — powered by **OpenRouter**, so you
can code with open-source models (GLM, Llama, Qwen, DeepSeek…), the frontier ones, and
older/"nostalgic" models, all behind one key.

Built from scratch (a real agent loop, not a wrapper), inspired by Codex / Claude Code /
OpenCode. Electron GUI + a stdlib-light Node agent core.

![screenshot](docs/screenshot.png)

## What it does

- **Agentic loop** — the model reads your codebase, edits files, runs commands, checks its
  work, and iterates until the task is done.
- **Any OpenRouter model** — searchable picker over the full live catalog (300+ models);
  type any model id, including ones not in the list.
- **Approvals** — every file write, edit, and shell command is gated. Approve with the
  mouse or the keyboard (**Enter** = allow, **Esc** = deny). Flip to **Plan mode** for
  read-only investigation.
- **Diffs** — every edit renders an inline green/red diff.
- **Streaming** — reasoning (on models that expose it) and answers stream live, with a
  tool-activity timeline and per-turn token counts.

## Architecture

```
src/
  agent/           the core — pure Node, testable headless
    provider.js    OpenRouter (OpenAI-compatible) streaming + tool-call assembly
    tools.js       read/list/glob/grep/write/edit/bash, path-scoped, approval-gated
    agent.js       the agentic loop (call → run tools → feed back → repeat)
    prompt.js      system prompt (build vs plan mode)
  main/            Electron main process + IPC + approval round-trip
  renderer/        the desktop UI (chat, diffs, model search, approvals)
run-headless.js    drive the agent from the terminal (no GUI) for testing
```

The agent core has zero dependencies and can be driven headless:

```bash
node run-headless.js "z-ai/glm-4.6" "/path/to/project" "add a test for foo()" --yes
```

## Run

```bash
npm install
npm start
```

The OpenRouter key is read from the app's Settings; on first run it bootstraps from
`~/.claude-harness/keys.json` if present. Stored locally only.

## License

MIT
