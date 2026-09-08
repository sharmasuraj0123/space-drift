import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import * as C from '../public/constants.js';

const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0') && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..');
const emptyResult = (reason) => ({ ok: false, reason });

export function decodeGitPath(value) {
  if (!value?.startsWith('"')) return value;
  const bytes = [];
  const text = value.slice(1, -1);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') { bytes.push(...Buffer.from(text[index])); continue; }
    const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); index += octal[0].length; continue; }
    const escaped = text[++index];
    const character = ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07' })[escaped] ?? escaped;
    bytes.push(...Buffer.from(character));
  }
  return Buffer.from(bytes).toString('utf8');
}

function renamePaths(value) {
  if (value.startsWith('"')) return { path: decodeGitPath(value) };
  const brace = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(value);
  if (brace) return { path: `${brace[1]}${brace[3]}${brace[4]}`, previousPath: `${brace[1]}${brace[2]}${brace[4]}` };
  const arrow = /^(.*?) => (.*)$/.exec(value);
  return arrow ? { path: arrow[2], previousPath: arrow[1] } : { path: value };
}

/** Both fixture-friendly quoted output and lossless -z records, including rename triples. */
export function parseNumstat(output) {
  const nul = output.includes('\0');
  const parts = output.split(nul ? '\0' : '\n');
  const rows = [];
  for (let index = 0; index < parts.length; index += 1) {
    const match = /^\n*(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[index]);
    if (!match) continue;
    let names;
    if (nul && match[3] === '') names = { previousPath: parts[++index], path: parts[++index] };
    else names = nul ? { path: match[3] } : renamePaths(match[3]);
    if (!safePath(names.path) || (names.previousPath && !safePath(names.previousPath))) continue;
    const binary = match[1] === '-' || match[2] === '-';
    rows.push({ ...names, added: binary ? null : Number(match[1]), removed: binary ? null : Number(match[2]), binary, delta: binary ? null : Number(match[1]) + Number(match[2]) });
  }
  return rows;
}

export function parseGitLog(output) {
  const events = [];
  for (const commit of output.split('\x01').slice(1)) {
    const header = /^(\d+)(?:\0([0-9a-f]+))?[\0\r\n]*/.exec(commit);
    if (!header) continue;
    const at = Number(header[1]) * 1000;
    const commitId = header[2] || header[1];
    for (const row of parseNumstat(commit.slice(header[0].length))) events.push({ ...row, at, commit: commitId, id: `git:${commitId}:${row.path}` });
  }
  return events;
}

export function parsePorcelain(output) {
  const records = new Map();
  const chunks = output.split('\0');
  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index];
    if (!record || record.startsWith('#')) continue;
    const type = record[0];
    if (type === '?') { const name = record.slice(2); if (safePath(name)) records.set(name, { status: 'untracked' }); continue; }
    if (!['1', '2', 'u'].includes(type)) continue;
    const count = type === '1' ? 8 : type === '2' ? 9 : 10;
    const parts = record.split(' ');
    const name = parts.slice(count).join(' ');
    const xy = parts[1] || '..';
    const previousPath = type === '2' ? chunks[++index] : undefined;
    if (!safePath(name)) continue;
    records.set(name, { status: type === 'u' || xy.includes('U') ? 'conflicted' : xy[1] !== '.' ? 'modified' : xy[0] !== '.' ? 'staged' : 'clean', xy, ...(previousPath ? { previousPath } : {}) });
  }
  return records;
}

function executeGit(program, args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...executionOptions } = options;
    const process = execFile(program, args, executionOptions, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }));
    process.stdin?.end(input || '');
  });
}

/** No app content reads. Git itself compares worktree bytes; all commands share one deadline. */
export async function readRepoChurn(repoDir, { windowDays = C.GIT_WINDOW_DAYS || 90, budgetMs = C.GIT_BUDGET_MS || 3000, now = Date.now(), execute = executeGit, metadata = new Map(), signal } = {}) {
  const deadline = Date.now() + Math.max(1, budgetMs);
  const window = Math.min(3650, Math.max(1, Math.floor(windowDays)));
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  // An inherited shell repository override must not redirect the selected cwd.
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete environment[key];
  const run = async (args, input = '') => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('Git budget expired'), { budget: true });
    const result = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: repoDir, timeout: remaining, maxBuffer: 8 * 1024 * 1024, env: environment, input, signal });
    return typeof result === 'string' ? result : result.stdout;
  };
  let timer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  // execFile cancellation is shared with the whole collection, not reset per command.
  const originalSignal = signal; signal = controller.signal;
  try {
    return await Promise.race([(async () => {
      const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const head = (await run(['rev-parse', '--short', 'HEAD'])).trim();
      const emptyTree = (await run(['hash-object', '-t', 'tree', '--stdin'])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(emptyTree)) return emptyResult('unavailable');
      const safety = ['--no-ext-diff', '--no-textconv'];
      const counted = parseNumstat(await run(['diff', '--numstat', '-z', '--no-renames', ...safety, emptyTree, 'HEAD', '--', '.']));
      const history = parseGitLog(await run(['log', '--numstat', '-z', '--no-merges', '--no-show-signature', `--since=${window}.days`, '--format=%x01%ct%x00%H', ...safety, '--', '.']));
      const working = parseNumstat(await run(['diff', '--numstat', '-z', ...safety, 'HEAD', '--', '.']));
      const statuses = parsePorcelain(await run(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', '.']));
      const lines = new Map(counted.filter((row) => !row.binary).map((row) => [row.path, row.added]));
      const tracked = new Set(counted.map((row) => row.path));
      const files = new Map();
      const ensure = (filePath) => {
        if (!files.has(filePath)) files.set(filePath, { excitations: [], status: statuses.get(filePath)?.status || 'clean', lastCommitAt: null });
        return files.get(filePath);
      };
      for (const filePath of tracked) ensure(filePath);
      for (const row of [...history].sort((a, b) => a.at - b.at)) {
        if (row.previousPath && files.has(row.previousPath)) {
          const previous = files.get(row.previousPath);
          files.set(row.path, { ...previous, excitations: [...previous.excitations], status: statuses.get(row.path)?.status || 'clean' });
          files.delete(row.previousPath);
        }
        const value = ensure(row.path);
        value.excitations.push({ id: row.id, at: row.at, delta: row.delta, binary: row.binary, previousPath: row.previousPath, source: 'git' });
        if (!value.lastCommitAt || row.at > value.lastCommitAt) value.lastCommitAt = row.at;
      }
      const observe = async (filePath) => {
        if (signal.aborted || Date.now() >= deadline) throw Object.assign(new Error('Git budget expired'), { budget: true });
        const known = metadata.get(filePath);
        try {
          const state = await lstat(path.join(repoDir, ...filePath.split('/')));
          return { mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs, size: state.size };
        } catch {
          const at = known?.mtimeMs ?? Date.parse(known?.modifiedAt);
          return { mtimeMs: Number.isFinite(at) ? at : now, ctimeMs: known?.ctimeMs, size: known?.size };
        }
      };
      for (const row of working) {
        if (row.previousPath && files.has(row.previousPath)) {
          const previous = files.get(row.previousPath);
          files.set(row.path, { ...previous, excitations: [...previous.excitations], status: statuses.get(row.path)?.status || 'modified' });
          if (lines.has(row.previousPath)) lines.set(row.path, lines.get(row.previousPath));
        }
        const value = ensure(row.path); const observation = await observe(row.path); const at = observation.mtimeMs;
        value.observation = observation;
        value.excitations.push({ id: `dirty:${head}:${row.path}:${row.delta}:${at}`, at, delta: row.delta, binary: row.binary, previousPath: row.previousPath, source: 'dirty' });
      }
      for (const [filePath, status] of statuses) {
        const value = ensure(filePath); value.status = status.status;
        if (status.status === 'untracked') {
          const observation = await observe(filePath); const at = observation.mtimeMs;
          value.observation = observation;
          value.excitations.push({ id: `untracked:${filePath}:${at}`, at, delta: null, binary: true, source: 'dirty' });
        }
      }
      return { ok: true, head, branch, dirty: statuses.size, lines, files, tracked, windowDays: window, reason: null, collectedAt: now };
    })(), new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(emptyResult('budget')); }, Math.max(1, budgetMs)); })]);
  } catch (error) {
    if (error.budget || error.killed || error.name === 'AbortError' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return emptyResult('budget');
    let marker;
    try { marker = await lstat(path.join(repoDir, '.git')); } catch { /* Missing root repository. */ }
    return emptyResult(!marker && /not a git repository|must be run in a work tree/i.test(error.stderr || error.message) ? 'not-a-work-tree' : 'unavailable');
  } finally {
    clearTimeout(timer); originalSignal?.removeEventListener('abort', abort);
  }
}
