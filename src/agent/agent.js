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
    this.goal = opts.goal || null;            // standing goal appended to the system prompt
    this.emit = opts.emit || (() => {});      // (event) => void
    this.approve = opts.approve || (async () => true);
    // extraTools: host-provided tools (MCP servers, browser). Shape:
    //   { schemas: [openai fn schemas], has(name), run(name,args)->Promise<result>,
    //     gate(name,args) -> {kind,detail,danger} | null (null = no approval needed) }
    this.extraTools = opts.extraTools || null;
    this.textTools = !!opts.textTools;   // ReAct-style text protocol for models without native tool calling
    this.hooks = opts.hooks || null;     // { pre(name,args)->{ok,reason}, post(name,args,result) }
    this.sandbox = opts.sandbox !== false;   // Seatbelt-wrap bash (macOS)
    this.ctxLimit = opts.ctxLimit || 0;      // model context window (tokens) for hard fitting
    this._steer = [];                        // mid-turn user interjections
    this.messages = [this._sys()];
  }

  // Steer a RUNNING turn: the message is injected at the next loop boundary.
  steer(text) { this._steer.push(String(text || '')); }
  _drainSteer() {
    let had = false;
    while (this._steer.length) {
      const t = this._steer.shift();
      this.messages.push({ role: 'user', content: '[User interjects mid-task — adjust course accordingly]: ' + t });
      this.emit({ type: 'steered', text: t });
      had = true;
    }
    return had;
  }

  // Trim old context: stale tool outputs and all-but-recent screenshots dominate
  // the window in long sessions; the model doesn't need them verbatim.
  _trim() {
    const keepFrom = Math.max(1, this.messages.length - 12);
    let imgs = 0;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      const m = this.messages[i];
      if (Array.isArray(m.content)) {
        if (m.content.some((c) => c.type === 'image_url')) {
          imgs++;
          if (imgs > 2) m.content = [{ type: 'text', text: '[earlier screenshot removed to save context]' }];
        }
      } else if (i < keepFrom && m.role === 'tool' && typeof m.content === 'string' && m.content.length > 1500) {
        m.content = m.content.slice(0, 1500) + '…[trimmed]';
      }
    }
  }

  _sys() {
    return {
      role: 'system',
      content: systemPrompt(this.cwd, this.mode) +
        (this.goal ? '\n\nSTANDING GOAL from the user (keep working toward it across turns): ' + this.goal : ''),
    };
  }

  setModel(m) { this.model = m; }
  setEffort(e) { this.effort = e || null; }
  setCtxLimit(n) { this.ctxLimit = n || 0; }

  _estTokens() {
    let n = 2700;   // system prompt + tool schemas overhead
    for (const m of this.messages) {
      if (typeof m.content === 'string') {
        n += m.content.length / 3.2 + 10;   // 3.2 chars/token: code tokenizes densely
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'image_url') n += 1300;   // vision images are TILED (~85–1600 tok), not tokenized as base64
          else n += String(part.text || '').length / 3.2;
        }
        n += 10;
      }
    }
    return Math.round(n);
  }

  // completion cap for small-context models: without max_tokens the provider
  // reserves 4096 on top of the prompt and 400s even when the prompt fits
  _maxTokens() {
    const limit = this.ctxLimit || 0;
    if (!limit || limit > 40000) return null;
    const room = limit - this._estTokens() - 400;
    return Math.max(600, Math.min(4096, room));
  }

  // Hard context fitting: providers reserve ~4k completion tokens on top of the
  // prompt, so small-context models 400 long before the raw limit. Drop the oldest
  // messages (in valid units — an assistant tool_call goes WITH its tool results)
  // until the request fits. Self-healing; runs before every model call.
  _fit() {
    const limit = this.ctxLimit || 0;
    if (!limit) return;
    const budget = Math.max(2500, limit * 0.62);   // leave completion + estimator-error headroom
    if (this._estTokens() <= budget) return;
    // pass 1: images are ~50k tokens each — strip them (except the newest user
    // message's) before sacrificing any conversation history
    let lastUser = -1;
    for (let i = this.messages.length - 1; i > 0; i--) if (this.messages[i].role === 'user') { lastUser = i; break; }
    let strippedImgs = 0;
    for (let i = 1; i < this.messages.length && this._estTokens() > budget; i++) {
      const m = this.messages[i];
      if (i !== lastUser && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')) {
        m.content = [{ type: 'text', text: '[image removed to fit the context window]' }];
        strippedImgs++;
      }
    }
    if (strippedImgs) this.emit({ type: 'control_note', message: '✂ removed ' + strippedImgs + ' old image(s) to fit the context window' });
    if (this._estTokens() <= budget) return;
    let dropped = 0;
    while (this._estTokens() > budget && this.messages.length > 8) {
      this.messages.splice(1, 1);
      dropped++;
      while (this.messages.length > 1 && this.messages[1] && this.messages[1].role === 'tool') {
        this.messages.splice(1, 1);   // never orphan tool results
        dropped++;
      }
    }
    if (dropped) {
      this._repairToolPairing();
      this.messages.splice(1, 0, { role: 'user', content: '[Note: ' + dropped + ' earlier messages were dropped to fit this model\'s context window. Ask the user if context you need is missing.]' });
      this.emit({ type: 'control_note', message: '✂ dropped ' + dropped + ' old messages to fit the ' + Math.round(limit / 1000) + 'k context window' });
    }
  }

  // Enforce the provider invariant regardless of what trimming did: every assistant
  // tool_calls message must be immediately followed by exactly its tool results, and
  // every tool message must answer the assistant directly before it.
  _repairToolPairing() {
    const out = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === 'tool') {
        const prev = out[out.length - 1];
        const prevOk = prev && ((prev.role === 'tool') || (prev.role === 'assistant' && Array.isArray(prev.tool_calls)));
        if (!prevOk) continue;   // orphaned tool result — drop it
        out.push(m);
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const ids = new Set(m.tool_calls.map((t) => t.id));
        const answered = new Set();
        for (let j = i + 1; j < this.messages.length && this.messages[j].role === 'tool'; j++) {
          if (ids.has(this.messages[j].tool_call_id)) answered.add(this.messages[j].tool_call_id);
        }
        if (answered.size !== ids.size) {   // unanswered calls — strip the tool_calls, keep any text
          const copy = { role: 'assistant', content: m.content || '[made tool calls whose results were trimmed]' };
          out.push(copy);
          while (i + 1 < this.messages.length && this.messages[i + 1].role === 'tool') i++;   // skip its partial results
          continue;
        }
      }
      out.push(m);
    }
    this.messages = out;
  }
  setMode(m) { this.mode = m; this.messages[0] = this._sys(); }
  setCwd(d) { this.cwd = d; this.messages[0] = this._sys(); }
  setGoal(g) { this.goal = g || null; this.messages[0] = this._sys(); }

  // Rebuild model memory from the UI transcript (which never loses messages) —
  // used when moving to a bigger-context model after heavy fitting shrank history.
  rehydrate(items) {
    const msgs = [this._sys()];
    for (const it of items) {
      if ((it.t === 'user' || it.t === 'assistant') && (it.text || '').trim()) {
        msgs.push({ role: it.t, content: it.text });
      }
    }
    if (msgs.length < 5) return false;
    this.messages = msgs;
    this._fit();
    return true;
  }

  // Restore a persisted conversation (message history saved to disk by the host).
  loadMessages(msgs) {
    if (Array.isArray(msgs) && msgs.length) this.messages = msgs;
    this.messages[0] = this._sys();
  }

  // Clear the conversation back to a fresh system prompt.
  reset() { this.messages = [this._sys()]; }

  // Compact: ask the model to summarize the session, then replace the history with
  // that summary so long sessions keep fitting in context (like /compact in Claude Code).
  async compact(signal) {
    const req = [...this.messages, {
      role: 'user',
      content: 'Summarize this entire session so far for your own future reference: the task(s), every file read or changed (with paths), key decisions, current state, and what remains. Be complete but concise. Reply with ONLY the summary.',
    }];
    // summarize on a large-context cheap model — compacting with the session model
    // fails exactly when compaction is needed (the history no longer fits it)
    let res;
    try {
      res = await streamChat({
        apiKey: this.apiKey, baseUrl: this.baseUrl, model: 'deepseek/deepseek-v4-flash',
        messages: req, tools: null, signal,
        onText: (d) => this.emit({ type: 'text', delta: d }),
      });
    } catch (e) {
      res = await streamChat({
        apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model,
        messages: req, tools: null, signal,
        onText: (d) => this.emit({ type: 'text', delta: d }),
      });
    }
    const summary = res.content || '';
    this.messages = [
      this._sys(),
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
    // Trust ladder: bypass auto-approves EVERYTHING (including destructive);
    // auto approves routine work but destructive always asks; edits approves
    // only file writes/edits (bash + destructive still ask); ask approves nothing.
    const gatedApprove = (kind, detail, opts = {}) => {
      if (this.mode === 'plan') return Promise.resolve(false);   // plan = read-only
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
    };
    this.messages[0] = this._sys();   // pick up HARNESS.md edits and mode changes every turn
    const { tools, schemas } = makeTools({
      cwd: this.cwd,
      sandbox: this.sandbox,
      approve: gatedApprove,
      onDiff: (file, before, after) => this.emit({ type: 'diff', file, before, after }),
      onPlan: (items) => this.emit({ type: 'plan', items }),
      onSnapshot: (p, before) => this.emit({ type: 'snapshot', path: p, before }),
    });
    // Plan mode advertises only read tools (browser_read is the one read-only extra).
    const extraSchemas = this.extraTools ? this.extraTools.schemas : [];
    const advertised = this.mode === 'plan'
      ? [...schemas.filter((s) => ['read_file', 'list_dir', 'glob', 'grep', 'update_plan'].includes(s.function.name)),
         ...extraSchemas.filter((s) => s.function.name === 'browser_read')]
      : [...schemas, ...extraSchemas];
    // Text-protocol fallback: models without native tool calling get the schemas
    // in the system prompt and reply with ```tool blocks we parse ourselves.
    if (this.textTools) {
      this.messages[0].content += '\n\n# TOOLS — TEXT PROTOCOL\nYou cannot call functions natively. To use a tool, reply with EXACTLY ONE fenced block and NOTHING else after it:\n```tool\n{"name": "<tool name>", "args": { ... }}\n```\nThen STOP. You will receive the result as the next message and can continue. When the task is complete, reply with your final answer and NO tool block.\n\nAvailable tools (JSON Schemas):\n' +
        advertised.map((s) => JSON.stringify({ name: s.function.name, description: (s.function.description || '').slice(0, 200), parameters: s.function.parameters })).join('\n');
    }

    let usageTotal = { prompt_tokens: 0, completion_tokens: 0, last_prompt: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal && signal.aborted) { this.emit({ type: 'aborted' }); return; }
      this.emit({ type: 'turn_start', step });
      this._drainSteer();
      this._trim();
      this._fit();
      this._repairToolPairing();   // idempotent; heals histories broken by older builds
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await streamChat({
            apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model,
            messages: this.messages, tools: this.textTools ? null : advertised, signal,
            reasoning: this.effort ? { effort: this.effort } : null,
            maxTokens: this._maxTokens(),
            onText: (d) => this.emit({ type: 'text', delta: d }),
            onReasoning: (d) => this.emit({ type: 'reasoning', delta: d }),
          });
          break;
        } catch (e) {
          const msg = String((e && e.message) || e);
          // estimator was optimistic — force-shrink and retry rather than strand the user
          if (attempt < 3 && this.ctxLimit && /context.length|maximum context|too many tokens|context_length_exceeded/i.test(msg)) {
            this.ctxLimit = Math.round(this.ctxLimit * 0.8);
            this._fit();
            continue;
          }
          this.emit({ type: 'error', message: msg });
          return;
        }
      }
      if (res.usage) {
        usageTotal.prompt_tokens += res.usage.prompt_tokens || 0;
        usageTotal.completion_tokens += res.usage.completion_tokens || 0;
        // last step's prompt size ≈ the current context-window footprint
        usageTotal.last_prompt = res.usage.prompt_tokens || usageTotal.last_prompt;
      }

      // In text-protocol mode, parse a ```tool block out of the reply ourselves.
      let toolCalls = res.tool_calls;
      let textParseError = null;
      if (this.textTools) {
        toolCalls = [];
        const m = (res.content || '').match(/```tool\s*\n([\s\S]*?)```/);
        if (m) {
          try {
            const j = JSON.parse(m[1]);
            if (j && j.name) toolCalls = [{ id: 'text-' + step, type: 'function', function: { name: j.name, arguments: JSON.stringify(j.args || j.arguments || {}) } }];
            else textParseError = 'the tool block had no "name" field';
          } catch (e) { textParseError = 'the tool block was not valid JSON: ' + e.message; }
        }
      }

      const assistantMsg = { role: 'assistant', content: res.content || '' };
      if (!this.textTools && toolCalls.length) assistantMsg.tool_calls = toolCalls;
      this.messages.push(assistantMsg);

      if (textParseError) {
        this.messages.push({ role: 'user', content: 'Your tool block failed to parse (' + textParseError + '). Reply with a corrected ```tool block, or your final answer with no tool block.' });
        continue;
      }
      if (!toolCalls.length) {                 // final answer…
        if (this._drainSteer()) continue;      // …unless the user interjected — keep going
        this.emit({ type: 'done', text: res.content, usage: usageTotal });
        return;
      }

      // Execute each tool call and append its result. Tool results MUST form a
      // contiguous block after the assistant message (OpenAI hard requirement) —
      // images returned by tools are injected only after the whole block.
      const deferredImages = [];
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        this.emit({ type: 'tool_call', name: tc.function.name, args });
        const tool = tools[tc.function.name];
        let result;
        let hookBlocked = false;
        if (this.hooks) {   // user pre_tool hook can veto any tool call
          try {
            const h = await this.hooks.pre(tc.function.name, args);
            if (h && !h.ok) { result = { error: 'blocked by pre_tool hook: ' + (h.reason || '(no reason)') }; hookBlocked = true; }
          } catch {}
        }
        if (hookBlocked) { /* result already set */ } else if (tool) {
          try { result = await tool.run(args); }
          catch (e) { result = { error: String(e.message || e) }; }
        } else if (this.extraTools && this.extraTools.has(tc.function.name)) {
          const gate = this.extraTools.gate ? this.extraTools.gate(tc.function.name, args) : null;
          const ok = gate ? await gatedApprove(gate.kind, gate.detail, { danger: !!gate.danger }) : true;
          if (!ok) result = { error: 'denied by user' };
          else {
            try { result = await this.extraTools.run(tc.function.name, args); }
            catch (e) { result = { error: String(e.message || e) }; }
          }
        } else result = { error: 'unknown tool: ' + tc.function.name };
        if (this.hooks && !hookBlocked) { try { this.hooks.post(tc.function.name, args, result); } catch {} }
        // Tool results are text-only in the OpenAI format. When a tool returns an
        // image (computer_screenshot), strip it from the result and inject it as a
        // follow-up user message so vision models actually SEE it.
        let image = null;
        if (result && result._image) {
          image = result._image;
          result = { ...result };
          delete result._image;
        }
        this.emit({ type: 'tool_result', name: tc.function.name, result });
        if (this.textTools) {
          this.messages.push({ role: 'user', content: 'TOOL RESULT for ' + tc.function.name + ':\n' + JSON.stringify(result).slice(0, 20000) });
        } else {
          this.messages.push({
            role: 'tool', tool_call_id: tc.id, name: tc.function.name,
            content: JSON.stringify(result).slice(0, 100000),
          });
        }
        if (image) deferredImages.push({ name: tc.function.name, url: image });
      }
      for (const img of deferredImages) {
        this.messages.push({ role: 'user', content: [
          { type: 'text', text: '[Screenshot from ' + img.name + ' — coordinates in this image are screen points you can click directly.]' },
          { type: 'image_url', image_url: { url: img.url } },
        ] });
        this.emit({ type: 'screenshot', dataUrl: img.url });
      }
    }
    this.emit({ type: 'error', message: 'stopped after ' + MAX_STEPS + ' steps (loop guard)' });
  }
}

module.exports = { Session };
