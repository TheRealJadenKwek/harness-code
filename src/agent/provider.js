'use strict';
// OpenRouter (OpenAI-compatible) streaming chat client with tool-call assembly.
// One turn = stream deltas, surfacing text as it arrives and accumulating any
// tool calls (their `arguments` stream as partial JSON fragments per index).
const https = require('https');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Stream one model turn.
 * @param opts.apiKey   OpenRouter key
 * @param opts.baseUrl  override endpoint (defaults to OpenRouter)
 * @param opts.model    model id (e.g. "z-ai/glm-4.6", "openai/gpt-3.5-turbo")
 * @param opts.messages chat history
 * @param opts.tools    tool schemas (OpenAI function format) or null
 * @param opts.onText   (delta) => void       — streamed assistant text
 * @param opts.onReasoning (delta) => void     — streamed reasoning (models that expose it)
 * @param opts.signal   AbortSignal
 * @returns {Promise<{content, tool_calls, finish_reason, usage}>}
 */
function streamChat(opts) {
  const { apiKey, model, messages, tools, onText, onReasoning, signal } = opts;
  const url = new URL(opts.baseUrl || OPENROUTER_URL);
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://harness.local',
        'X-Title': 'Harness Code',
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', (c) => (err += c));
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + err.slice(0, 500))));
        return;
      }
      let buf = '';
      let content = '';
      const toolCalls = [];       // assembled by index
      let finish = null;
      let usage = null;

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let d;
          try { d = JSON.parse(data); } catch { continue; }
          if (d.usage) usage = d.usage;
          const choice = d.choices && d.choices[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.content) { content += delta.content; onText && onText(delta.content); }
          const reason = delta.reasoning || delta.reasoning_content;
          if (reason) { onReasoning && onReasoning(reason); }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index || 0;
              if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function) {
                if (tc.function.name) toolCalls[i].function.name = tc.function.name;
                if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
              }
            }
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      });
      res.on('end', () => resolve({
        content,
        tool_calls: toolCalls.filter(Boolean),
        finish_reason: finish,
        usage,
      }));
      res.on('error', reject);
    });

    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    req.write(body);
    req.end();
  });
}

module.exports = { streamChat, OPENROUTER_URL };
