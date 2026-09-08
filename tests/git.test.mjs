import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumstat, parseGitLog, parsePorcelain, readRepoChurn } from '../lib/git.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUniverseReader } from '../lib/universe.mjs';

test('numstat parses quoted paths, brace/arrow renames, binary rows, and lossless NUL records', () => {
  const rows = parseNumstat('10\t2\t"caf\\303\\251.txt"\n2\t3\tlib/{old => new}/x.js\n1\t0\told.md => new.md\n-\t-\tphoto.png\n');
  assert.equal(rows[0].path, 'café.txt'); assert.equal(rows[0].delta, 12);
  assert.deepEqual([rows[1].previousPath, rows[1].path], ['lib/old/x.js', 'lib/new/x.js']);
  assert.equal(rows[2].path, 'new.md'); assert.equal(rows[3].binary, true);
  const lossless = parseNumstat('1\t2\t\0before\0after\0-\t-\tnew\nline\tfile.png\0');
  assert.equal(lossless[0].previousPath, 'before'); assert.equal(lossless[0].path, 'after');
  assert.equal(lossless[1].path, 'new\nline\tfile.png');
  assert.deepEqual(parseNumstat('1\t0\t../escape\n1\t0\t/absolute\n'), []);
});

test('log and porcelain distinguish chronological changes, status and rename destination', () => {
  const events = parseGitLog('\x01200\0abc\0\n10\t2\tcode.js\0\x01100\0def\0\n-\t-\timage.png\0');
  assert.deepEqual(events.map((e) => [e.path, e.at, e.delta]), [['code.js', 200000, 12], ['image.png', 100000, null]]);
  const status = parsePorcelain('1 .M N... 100644 100644 100644 a b modified.js\0' +
    '1 M. N... 100644 100644 100644 a b staged.js\0' +
    '2 R. N... 100644 100644 100644 a b R100 new name.js\0old name.js\0' +
    'u UU N... 100644 100644 100644 100644 a b c conflict.js\0? new.js\0');
  assert.equal(status.get('modified.js').status, 'modified'); assert.equal(status.get('staged.js').status, 'staged');
  assert.equal(status.get('new name.js').previousPath, 'old name.js');
  assert.equal(status.get('conflict.js').status, 'conflicted'); assert.equal(status.get('new.js').status, 'untracked');
});

test('Git collection uses fixed argv and one HEAD diff for staged/worktree changes, exact HEAD lines and mtime for dirty rows', async () => {
  const calls = []; const hash = '4'.repeat(40);
  const execute = async (program, args, options) => {
    calls.push({ program, args, options });
    const cmd = args[3];
    if (cmd === 'rev-parse') return { stdout: args[4] === '--abbrev-ref' ? 'main\n' : 'abcdef\n' };
    if (cmd === 'hash-object') return { stdout: hash };
    if (cmd === 'log') return { stdout: '\x0110\0aaa\0\n10\t0\tcode.js\0' };
    if (cmd === 'status') return { stdout: '1 MM N... 100644 100644 100644 a b code.js\0? new.txt\0' };
    if (args.includes(hash)) return { stdout: '20\t0\tcode.js\0-\t-\timage.png\0' };
    return { stdout: '2\t3\tcode.js\0' };
  };
  const result = await readRepoChurn('/fixture/repo', { execute, now: 100000, metadata: new Map([['code.js', { mtimeMs: 90000 }], ['new.txt', { mtimeMs: 80000 }]]) });
  assert.equal(result.ok, true); assert.equal(result.lines.get('code.js'), 20); assert.equal(result.lines.has('image.png'), false);
  assert.deepEqual(result.files.get('code.js').excitations.map((e) => [e.at, e.delta]), [[10000, 10], [90000, 5]]);
  assert.equal(result.files.get('new.txt').excitations[0].delta, null);
  assert.equal(calls.filter((c) => c.args[3] === 'diff' && !c.args.includes(hash)).length, 1);
  assert.ok(calls.every((c) => c.program === 'git' && c.options.cwd === '/fixture/repo' && c.options.shell === undefined && c.options.maxBuffer === 8388608 && c.options.env.GIT_OPTIONAL_LOCKS === '0'));
  assert.ok(calls.every((c) => c.args.includes('core.fsmonitor=false')));
  assert.ok(calls.find((c) => c.args[3] === 'log').args.includes('--no-merges'));
  assert.ok(calls.filter((c) => ['log', 'diff'].includes(c.args[3])).every((c) => c.args.includes('--no-ext-diff') && c.args.includes('--no-textconv')));
});

test('a shared Git deadline bounds stalled commands and missing worktrees fall back', async () => {
  let calls = 0; const start = Date.now();
  const slow = await readRepoChurn('/fixture/missing', { budgetMs: 20, execute: () => { calls += 1; return new Promise(() => {}); } });
  assert.equal(slow.reason, 'budget'); assert.equal(calls, 1); assert.ok(Date.now() - start < 200);
  const failed = await readRepoChurn('/fixture/missing', { execute: async () => { throw Object.assign(new Error('not a git repository'), { stderr: 'not a git repository' }); } });
  assert.equal(failed.reason, 'not-a-work-tree');
});

test('a real linked worktree reads its backing Git directory outside the selected root and missing gitdir falls back', async (t) => {
  const execute = promisify(execFile);
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'space-linked-worktree-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const backing = path.join(fixture, 'backing'); const selected = path.join(fixture, 'selected');
  await mkdir(backing);
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete environment[key];
  const git = (args) => execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.attributesFile=/dev/null', ...args], { cwd: backing, timeout: 5000, env: environment });
  // All mutations below are confined to this temporary test fixture.
  await git(['init', '--quiet', '--template=']);
  await writeFile(path.join(backing, 'code.js'), 'one\ntwo\nthree\n');
  await git(['add', '--', 'code.js']); await git(['commit', '--quiet', '-m', 'fixture']);
  await git(['worktree', 'add', '--quiet', '-b', 'fixture-linked', selected]);
  const marker = await readFile(path.join(selected, '.git'), 'utf8');
  assert.ok(marker.startsWith('gitdir: ')); assert.ok(!marker.slice('gitdir: '.length).trim().startsWith(selected + '/'));
  await writeFile(path.join(selected, 'code.js'), 'one\nchanged\nthree\nfour\n');
  const result = await readRepoChurn(selected);
  assert.equal(result.ok, true); assert.equal(result.branch, 'fixture-linked'); assert.equal(result.lines.get('code.js'), 3);
  assert.equal(result.files.get('code.js').status, 'modified');
  assert.equal(result.files.get('code.js').excitations.find((event) => event.source === 'dirty').delta, 3);
  const universe = createUniverseReader(selected); t.after(() => universe.dispose());
  const first = await universe.readPlanet('.'); assert.equal(first.atoms[0].id, 'code.js');
  let body; const deadline = Date.now() + 5000;
  do { body = await universe.readPlanet('.'); if (body.git.enabled) break; await new Promise((resolve) => setTimeout(resolve, 5)); } while (Date.now() < deadline);
  assert.equal(body.git.enabled, true); assert.equal(body.atoms[0].lines, 3); assert.equal(body.atoms[0].linesExact, true);
  universe.dispose();
  await writeFile(path.join(selected, '.git'), `gitdir: ${path.join(fixture, 'missing-gitdir')}\n`);
  assert.equal((await readRepoChurn(selected)).reason, 'unavailable');
});

test('chronological rename history carries prior excitation to the current path', async () => {
  const empty = '4'.repeat(40);
  const result = await readRepoChurn('/fixture/rename', { now: 300000, execute: async (program, args) => {
    const command = args[3];
    if (command === 'rev-parse') return { stdout: 'main' };
    if (command === 'hash-object') return { stdout: empty };
    if (command === 'log') return { stdout: '\x01200\0bbb\0\n0\t0\t\0old.js\0new.js\0\x01100\0aaa\0\n10\t0\told.js\0' };
    if (command === 'diff' && args.includes(empty)) return { stdout: '20\t0\tnew.js\0' };
    return { stdout: '' };
  } });
  assert.equal(result.ok, true); assert.deepEqual(result.files.get('new.js').excitations.map((event) => [event.at, event.delta]), [[100000, 10], [200000, 0]]);
  assert.equal(result.files.has('old.js'), false);
});
