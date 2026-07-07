'use strict';
// The agentic loop: call the model, run any tool calls (approval-gated), feed
// results back, repeat until the model answers with no more tool calls. Emits
// structured events so both a headless runner and the GUI can render progress.
const { streamChat } = require('./provider');
const { makeTools } = require('./tools');
const { systemPrompt } = require('./prompt');

const MAX_STEPS = 40;

class Session {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.mode = opts.mode || 'ask';           // 'plan' | 'ask' | 'edits' | 'auto' | 'bypass'
    this.effort = opts.effort || null;        // null (model default) | 'low' | 'medium' | 'high'
    this.emit = opts.emit || (() => {});      // (event) => void
    this.approve = opts.approve || (async () => true);
    this.messages = [{ role: 'system', content: systemPrompt(this.cwd, this.mode) }];
  }

  setModel(m) { this.model = m; }
  setEffort(e) { this.effort = e || null; }
  setMode(m) { this.mode = m; this.messages[0] = { role: 'system', content: systemPrompt(this.cwd, this.mode) }; }
  setCwd(d) { this.cwd = d; this.messages[0] = { role: 'system', content: systemPrompt(this.cwd, this.mode) }; }

  // Restore a persisted conversation (message history saved to disk by the host).
  loadMessages(msgs) {
    if (Array.isArray(msgs) && msgs.length) this.messages = msgs;
    this.messages[0] = { role: 'system', content: systemPrompt(this.cwd, this.mode) };
  }

  // Clear the conversation back to a fresh system prompt.
  reset() { this.messages = [{ role: 'system', content: systemPrompt(this.cwd, this.mode) }]; }

  // Compact: ask the model to summarize the session, then replace the history with
  // that summary so long sessions keep fitting in context (like /compact in Claude Code).
  async compact(signal) {
    const req = [...this.messages, {
      role: 'user',
      content: 'Summarize this entire session so far for your own future reference: the task(s), every file read or changed (with paths), key decisions, current state, and what remains. Be complete but concise. Reply with ONLY the summary.',
    }];
    const res = await streamChat({
      apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model,
      messages: req, tools: null, signal,
      onText: (d) => this.emit({ type: 'text', delta: d }),
    });
    const summary = res.content || '';
    this.messages = [
      { role: 'system', content: systemPrompt(this.cwd, this.mode) },
      { role: 'user', content: '[Context was compacted. Summary of the session so far:]\n\n' + summary },
      { role: 'assistant', content: 'Understood — I have the full context from that summary and will continue from there.' },
    ];
    this.emit({ type: 'compacted', summary });
    return summary;
  }

  async send(userInput, signal) {
    // userInput: string, or { text, images: [dataUrl] } for vision models.
    let content = userInput;
    if (typeof userInput === 'object' && userInput !== null) {
      content = (userInput.images && userInput.images.length)
        ? [{ type: 'text', text: userInput.text || '' },
           ...userInput.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
        : (userInput.text || '');
    }
    this.messages.push({ role: 'user', content });
    const { tools, schemas } = makeTools({
      cwd: this.cwd,
      approve: (kind, detail, opts = {}) => {
        if (this.mode === 'plan') return Promise.resolve(false);   // plan = read-only
        // Trust ladder: bypass auto-approves EVERYTHING (including destructive);
        // auto approves routine work but destructive always asks; edits approves
        // only file writes/edits (bash + destructive still ask); ask approves nothing.
        const danger = !!opts.danger;
        const autoOk =
          this.mode === 'bypass' ? true
          : this.mode === 'auto' ? !danger
          : this.mode === 'edits' ? (!danger && (kind === 'write' || kind === 'edit'))
          : false;
        if (autoOk) {
          this.emit({ type: 'auto_approved', kind, detail });
          return Promise.resolve(true);
        }
        this.emit({ type: 'approval_request', kind, detail, danger });
        return this.approve(kind, detail, opts);
      },
      onDiff: (file, before, after) => this.emit({ type: 'diff', file, before, after }),
    });
    // Plan mode advertises only read tools.
    const advertised = this.mode === 'plan'
      ? schemas.filter((s) => ['read_file', 'list_dir', 'glob', 'grep'].includes(s.function.name))
      : schemas;

    let usageTotal = { prompt_tokens: 0, completion_tokens: 0, last_prompt: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal && signal.aborted) { this.emit({ type: 'aborted' }); return; }
      this.emit({ type: 'turn_start', step });
      let res;
      try {
        res = await streamChat({
          apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model,
          messages: this.messages, tools: advertised, signal,
          reasoning: this.effort ? { effort: this.effort } : null,
          onText: (d) => this.emit({ type: 'text', delta: d }),
          onReasoning: (d) => this.emit({ type: 'reasoning', delta: d }),
        });
      } catch (e) {
        this.emit({ type: 'error', message: String(e.message || e) });
        return;
      }
      if (res.usage) {
        usageTotal.prompt_tokens += res.usage.prompt_tokens || 0;
        usageTotal.completion_tokens += res.usage.completion_tokens || 0;
        // last step's prompt size ≈ the current context-window footprint
        usageTotal.last_prompt = res.usage.prompt_tokens || usageTotal.last_prompt;
      }

      const assistantMsg = { role: 'assistant', content: res.content || '' };
      if (res.tool_calls.length) assistantMsg.tool_calls = res.tool_calls;
      this.messages.push(assistantMsg);

      if (!res.tool_calls.length) {                 // final answer
        this.emit({ type: 'done', text: res.content, usage: usageTotal });
        return;
      }

      // Execute each tool call and append its result.
      for (const tc of res.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        this.emit({ type: 'tool_call', name: tc.function.name, args });
        const tool = tools[tc.function.name];
        let result;
        if (!tool) result = { error: 'unknown tool: ' + tc.function.name };
        else {
          try { result = await tool.run(args); }
          catch (e) { result = { error: String(e.message || e) }; }
        }
        this.emit({ type: 'tool_result', name: tc.function.name, result });
        this.messages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.function.name,
          content: JSON.stringify(result).slice(0, 100000),
        });
      }
    }
    this.emit({ type: 'error', message: 'stopped after ' + MAX_STEPS + ' steps (loop guard)' });
  }
}

module.exports = { Session };
