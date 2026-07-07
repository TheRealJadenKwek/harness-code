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
    this.mode = opts.mode || 'build';         // 'build' | 'plan'
    this.emit = opts.emit || (() => {});      // (event) => void
    this.approve = opts.approve || (async () => true);
    this.messages = [{ role: 'system', content: systemPrompt(this.cwd, this.mode) }];
  }

  setModel(m) { this.model = m; }
  setMode(m) { this.mode = m; this.messages[0] = { role: 'system', content: systemPrompt(this.cwd, this.mode) }; }
  setCwd(d) { this.cwd = d; this.messages[0] = { role: 'system', content: systemPrompt(this.cwd, this.mode) }; }

  async send(userText, signal) {
    this.messages.push({ role: 'user', content: userText });
    const { tools, schemas } = makeTools({
      cwd: this.cwd,
      approve: (kind, detail) => {
        if (this.mode === 'plan') return Promise.resolve(false);   // plan mode = read-only
        this.emit({ type: 'approval_request', kind, detail });
        return this.approve(kind, detail);
      },
      onDiff: (file, before, after) => this.emit({ type: 'diff', file, before, after }),
    });
    // Plan mode advertises only read tools.
    const advertised = this.mode === 'plan'
      ? schemas.filter((s) => ['read_file', 'list_dir', 'glob', 'grep'].includes(s.function.name))
      : schemas;

    let usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal && signal.aborted) { this.emit({ type: 'aborted' }); return; }
      this.emit({ type: 'turn_start', step });
      let res;
      try {
        res = await streamChat({
          apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model,
          messages: this.messages, tools: advertised, signal,
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
