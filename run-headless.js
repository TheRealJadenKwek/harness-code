'use strict';
// Headless test harness: drives a real agent turn against OpenRouter so the core
// is verified before the GUI exists. Auto-approves in --yes mode.
//   node run-headless.js "<model>" "<cwd>" "<task>" [--yes] [--plan]
const { Session } = require('./src/agent/agent');
const fs = require('fs');

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const k = JSON.parse(fs.readFileSync(process.env.HOME + '/.claude-harness/keys.json', 'utf8'));
    return k.OPENROUTER_API_KEY;
  } catch { return null; }
}

async function main() {
  const [model, cwd, task] = process.argv.slice(2);
  const yes = process.argv.includes('--yes');
  const plan = process.argv.includes('--plan');
  const apiKey = loadKey();
  if (!apiKey) { console.error('no OPENROUTER_API_KEY'); process.exit(1); }
  if (!model || !cwd || !task) { console.error('usage: node run-headless.js <model> <cwd> <task> [--yes] [--plan]'); process.exit(1); }

  const s = new Session({
    apiKey, model, cwd, mode: plan ? 'plan' : 'build',
    approve: async (kind, detail) => {
      console.log(`\n  ⚠️  APPROVE ${kind}: ${detail.slice(0, 120)} -> ${yes ? 'auto-yes' : 'auto-yes(test)'}`);
      return true;
    },
    emit: (e) => {
      if (e.type === 'text') process.stdout.write(e.delta);
      else if (e.type === 'reasoning') process.stdout.write('\x1b[90m' + e.delta + '\x1b[0m');
      else if (e.type === 'tool_call') console.log(`\n  \x1b[36m▸ ${e.name}(${JSON.stringify(e.args).slice(0, 160)})\x1b[0m`);
      else if (e.type === 'tool_result') {
        const r = e.result || {};
        console.log(`  \x1b[32m✓ ${e.name}\x1b[0m ${(r.error ? ('ERR ' + r.error) : Object.keys(r).join(',')).slice(0, 120)}`);
      }
      else if (e.type === 'diff') console.log(`  \x1b[35m± ${e.file} (${e.before.length}→${e.after.length} bytes)\x1b[0m`);
      else if (e.type === 'done') console.log(`\n\n  \x1b[1mDONE\x1b[0m — tokens ~${(e.usage.prompt_tokens + e.usage.completion_tokens)}`);
      else if (e.type === 'error') console.log(`\n  \x1b[31mERROR: ${e.message}\x1b[0m`);
    },
  });
  await s.send(task);
}
main();
