# ⬡ Harness Code

Your own coding agent on the desktop — like Codex or Claude Code, but **OpenRouter-native**: code with open-source models (GLM, Qwen, DeepSeek, Llama…), frontier models, and older "nostalgic" models behind one key.

Built from scratch (a real agent loop, not a wrapper). Electron GUI + a zero-dependency Node agent core.

![screenshot](docs/screenshot.png)

## Features

- **Multi-session sidebar** — parallel chats, each with its own working directory, model, and permission mode. Sessions run concurrently and **persist across restarts**.
- **Agentic loop** — read / list / glob / grep / write / edit / bash tools, streamed tool-call assembly, up to 40 steps per turn.
- **Streaming UI** — markdown answers (code blocks, inline code, links), collapsible ✳ thinking blocks, collapsible tool cards with args + results.
- **Inline diffs** in the chat for every write/edit, plus a **git Changes panel** (⌘D): status by file, colored unified diffs, auto-refresh as the agent edits.
- **Run & Preview** (▷) — start a dev server (suggestions from package.json scripts); its URL is auto-detected (logs + port probing) and loads in an embedded **live preview** with a URL bar.
- **Background tasks** — a process manager for dev servers/watchers: live logs, running badge, stop kills the whole process tree.
- **Files panel** (⇧⌘F) — lazy project tree with read-only file preview. **⋮ menu**: Open in Finder / Terminal / VS Code, sessions folder.
- **Five permission modes** per session, picked from a menu on the mode pill (1–5): 📋 Plan (read-only) / 🔨 Manual (approve everything) / ✎ Accept edits (file edits auto-approve, bash asks) / ⚡ Auto (routine work auto-approves) / ⚠ Bypass (everything auto-approves). The **destructive-action guard** (rm, resets, overwrites, sudo…) stops and asks in every mode except Bypass. Per-model trust memory: each model remembers the mode you last used with it.
- **@-file mentions** with fuzzy autocomplete, **slash commands** (`/model`, `/mode`, `/dir`, `/clear`, `/compact`, `/rename`, `/diff`, `/help`).
- **/compact** — summarize the session and compress the context, Claude Code style.
- **Message queueing** — type while the agent is working; messages send when the turn ends.
- **Model picker** (⌘K) — the full OpenRouter catalog (300+), searchable, with pricing and context length, cached for instant open. Type any model id, including ones not in the list.
- **＋ attach menu** (⌘U) — add photos (sent to vision models as real image input), files (inserted as @mentions), or a folder; jump to slash commands.
- **Reasoning effort selector** — faster ↔ smarter per session (OpenRouter unified `reasoning.effort`).
- **Context & usage popover** — click the token meter: context-window fill bar for the current model, session cost, and your live OpenRouter credit balance.
- **Monochrome UI, light & dark** — follows the system theme.
- **Keyboard-first** — ⌘N new chat, ⌘K models, ⌘B sidebar, ⌘D changes panel, ⌘1–9 switch session, ⇧Tab cycle mode, Enter/Esc approve/deny, Esc stop.

## Run

```bash
npm install
npm start
```

The OpenRouter key is set in Settings on first launch; it bootstraps from `~/.claude-harness/keys.json` if present. Stored locally only.

Headless (no GUI):

```bash
node run-headless.js "openai/gpt-4o-mini" "/path/to/project" "add a test for foo()" --auto
```

## Architecture

```
src/
  agent/           the core — pure Node, testable headless
    provider.js    OpenRouter (OpenAI-compatible) streaming + tool-call assembly
    tools.js       read/list/glob/grep/write/edit/bash, path-scoped, approval-gated
    agent.js       the agentic loop + /compact + persistence hooks
    prompt.js      system prompt (per permission mode)
  main/            Electron main: session manager, persistence, git, models cache, IPC
  renderer/        the desktop UI (vanilla JS, no framework)
run-headless.js    drive the agent from the terminal (no GUI) for testing
```

Sessions persist to `~/Library/Application Support/harness-code/sessions/`.

## License

MIT
