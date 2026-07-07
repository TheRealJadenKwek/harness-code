'use strict';
// Agent tools: the file/search/shell operations the model can call. Each has an
// OpenAI-format schema (advertised to the model) and a run() that executes it.
// Mutating tools (write/edit/bash) go through an async approve() gate the host
// supplies, so the GUI can prompt the user (the "Ask/plan vs build" permission model).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function inside(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : null;
}

// Shell commands that can destroy work — these ALWAYS require approval, even for a
// trusted model in Auto mode. This is the "don't let it mess up my good files" net.
const DESTRUCTIVE = [
  /\brm\s+/i, /\b(rmdir|shred|unlink)\b/i,
  /\bgit\s+reset\s+--hard/i, /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+(--\s+)?[.\s]/i, /\bgit\s+restore\b/i,
  /\bfind\b[^|]*-delete/i, /\bxargs\b[^|]*\brm\b/i,
  /\b(mkfs|dd|truncate)\b/i, /\bsudo\b/i,
  /:\s*\(\s*\)\s*\{/, /\bchmod\s+-R/i, /\bchown\s+-R/i,
  /\bmv\s+.+\s+\//i,          // moving onto an absolute path
];
function isDestructiveShell(cmd) { return DESTRUCTIVE.some((re) => re.test(cmd || '')); }

function makeTools(ctx) {
  // ctx: { cwd, approve(kind, detail)->Promise<bool>, onDiff(file, before, after) }
  const R = () => ctx.cwd;

  const tools = {
    read_file: {
      schema: {
        name: 'read_file',
        description: 'Read a UTF-8 text file within the working directory. Returns its contents.',
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
        }, required: ['path'] },
      },
      run: async ({ path: p }) => {
        const abs = inside(R(), p);
        if (!abs) return { error: 'path escapes the working directory' };
        if (!fs.existsSync(abs)) return { error: 'no such file: ' + p };
        const data = fs.readFileSync(abs, 'utf8');
        return { path: p, bytes: data.length, content: data.slice(0, 100000) };
      },
    },

    list_dir: {
      schema: {
        name: 'list_dir',
        description: 'List entries in a directory (relative to the working directory).',
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: 'Directory path; defaults to "." ' },
        } },
      },
      run: async ({ path: p = '.' }) => {
        const abs = inside(R(), p);
        if (!abs) return { error: 'path escapes the working directory' };
        if (!fs.existsSync(abs)) return { error: 'no such directory: ' + p };
        const entries = fs.readdirSync(abs, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') || e.name === '.env')
          .slice(0, 500)
          .map((e) => e.name + (e.isDirectory() ? '/' : ''));
        return { path: p, entries };
      },
    },

    glob: {
      schema: {
        name: 'glob',
        description: 'Find files by a substring or extension match (recursive, skips node_modules/.git). Returns matching paths.',
        parameters: { type: 'object', properties: {
          query: { type: 'string', description: 'Substring or extension (e.g. ".ts", "provider").' },
        }, required: ['query'] },
      },
      run: async ({ query }) => {
        const out = [];
        const walk = (dir, depth) => {
          if (depth > 8 || out.length >= 300) return;
          let ents;
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (full.includes(query)) out.push(path.relative(R(), full));
          }
        };
        walk(R(), 0);
        return { query, matches: out.slice(0, 300) };
      },
    },

    grep: {
      schema: {
        name: 'grep',
        description: 'Search file contents for a regular expression (recursive, skips node_modules/.git). Returns file:line matches.',
        parameters: { type: 'object', properties: {
          pattern: { type: 'string', description: 'A regular expression.' },
        }, required: ['pattern'] },
      },
      run: async ({ pattern }) => {
        let re;
        try { re = new RegExp(pattern); } catch (e) { return { error: 'bad regex: ' + e.message }; }
        const hits = [];
        const walk = (dir, depth) => {
          if (depth > 8 || hits.length >= 200) return;
          let ents;
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            let text;
            try {
              if (fs.statSync(full).size > 512 * 1024) continue;
              text = fs.readFileSync(full, 'utf8');
            } catch { continue; }
            text.split('\n').forEach((ln, i) => {
              if (hits.length < 200 && re.test(ln)) hits.push(path.relative(R(), full) + ':' + (i + 1) + ': ' + ln.trim().slice(0, 200));
            });
          }
        };
        walk(R(), 0);
        return { pattern, matches: hits };
      },
    },

    write_file: {
      schema: {
        name: 'write_file',
        description: 'Create or overwrite a text file within the working directory. Requires user approval.',
        parameters: { type: 'object', properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        }, required: ['path', 'content'] },
      },
      run: async ({ path: p, content }) => {
        const abs = inside(R(), p);
        if (!abs) return { error: 'path escapes the working directory' };
        const existed = fs.existsSync(abs);
        const before = existed ? fs.readFileSync(abs, 'utf8') : '';
        // Overwriting an existing non-empty file is the "messing up a good file" case.
        const danger = before.trim().length > 0;
        const ok = await ctx.approve('write', p + (danger ? '  (overwrites existing file)' : ''), { danger });
        if (!ok) return { error: 'denied by user' };
        ctx.onSnapshot && ctx.onSnapshot(p, existed ? before : null);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        ctx.onDiff && ctx.onDiff(p, before, content);
        return { path: p, written: content.length };
      },
    },

    edit_file: {
      schema: {
        name: 'edit_file',
        description: 'Replace an exact string in a file with a new string (the old string must appear exactly once). Requires user approval.',
        parameters: { type: 'object', properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file).' },
          new_string: { type: 'string' },
        }, required: ['path', 'old_string', 'new_string'] },
      },
      run: async ({ path: p, old_string, new_string }) => {
        const abs = inside(R(), p);
        if (!abs) return { error: 'path escapes the working directory' };
        if (!fs.existsSync(abs)) return { error: 'no such file: ' + p };
        const before = fs.readFileSync(abs, 'utf8');
        const count = before.split(old_string).length - 1;
        if (count === 0) return { error: 'old_string not found' };
        if (count > 1) return { error: 'old_string is not unique (' + count + ' matches) — add more context' };
        const after = before.replace(old_string, new_string);
        const ok = await ctx.approve('edit', p);
        if (!ok) return { error: 'denied by user' };
        ctx.onSnapshot && ctx.onSnapshot(p, before);
        fs.writeFileSync(abs, after);
        ctx.onDiff && ctx.onDiff(p, before, after);
        return { path: p, replaced: true };
      },
    },

    update_plan: {
      schema: {
        name: 'update_plan',
        description: 'Create or update your task checklist. Call this FIRST on multi-step tasks, then again whenever an item completes (done:true) or the plan changes. The user sees this live.',
        parameters: { type: 'object', properties: {
          items: { type: 'array', items: { type: 'object', properties: {
            text: { type: 'string' }, done: { type: 'boolean' },
          }, required: ['text'] } },
        }, required: ['items'] },
      },
      run: async ({ items }) => {
        const list = (Array.isArray(items) ? items : []).slice(0, 20)
          .map((i) => ({ text: String(i.text || '').slice(0, 140), done: !!i.done }));
        ctx.onPlan && ctx.onPlan(list);
        return { ok: true, items: list.length };
      },
    },

    applescript: {
      schema: {
        name: 'applescript',
        description: 'Run AppleScript on the user\'s Mac to control other applications (open apps, read/set window state, send keystrokes, query Finder/Music/Calendar, etc). This is computer use — it ALWAYS requires explicit user approval.',
        parameters: { type: 'object', properties: {
          script: { type: 'string', description: 'The AppleScript source to execute.' },
        }, required: ['script'] },
      },
      run: async ({ script }) => {
        // Controlling other apps can do anything the user can — always danger-gated.
        const ok = await ctx.approve('applescript', script, { danger: true });
        if (!ok) return { error: 'denied by user' };
        return await new Promise((resolve) => {
          execFile('osascript', ['-e', script], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout, stderr) => {
              resolve({
                exit_code: err ? (err.code == null ? 1 : err.code) : 0,
                stdout: (stdout || '').slice(0, 20000),
                stderr: (stderr || '').slice(0, 8000),
              });
            });
        });
      },
    },

    bash: {
      schema: {
        name: 'bash',
        description: 'Run a shell command in the working directory. Requires user approval. Returns stdout/stderr (truncated).',
        parameters: { type: 'object', properties: {
          command: { type: 'string' },
        }, required: ['command'] },
      },
      run: async ({ command }) => {
        const danger = isDestructiveShell(command);
        const ok = await ctx.approve('bash', command, { danger });
        if (!ok) return { error: 'denied by user' };
        // Seatbelt sandbox (like Claude Code/Codex): reads anywhere, writes only to
        // the project + temp. Toggleable in Settings; denials surface as EPERM.
        const useSandbox = ctx.sandbox && process.platform === 'darwin';
        const profile = '(version 1)(allow default)(deny file-write*)' +
          '(allow file-write* (subpath ' + JSON.stringify(R()) + ') (subpath "/private/tmp") (subpath "/tmp")' +
          ' (subpath "/private/var/folders") (subpath "/dev") (literal "/dev/null"))';
        const bin = useSandbox ? '/usr/bin/sandbox-exec' : '/bin/bash';
        const args = useSandbox ? ['-p', profile, '/bin/bash', '-lc', command] : ['-lc', command];
        return await new Promise((resolve) => {
          execFile(bin, args, { cwd: R(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
              resolve({
                command,
                exit_code: err ? (err.code == null ? 1 : err.code) : 0,
                stdout: (stdout || '').slice(0, 40000),
                stderr: (stderr || '').slice(0, 20000),
                ...(err && err.killed ? { timed_out: true } : {}),
              });
            });
        });
      },
    },
  };

  const schemas = Object.values(tools).map((t) => ({ type: 'function', function: t.schema }));
  return { tools, schemas };
}

module.exports = { makeTools };
