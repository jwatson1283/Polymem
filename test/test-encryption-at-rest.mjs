// test-encryption-at-rest.mjs
//
// THE SUITE FOR OPTIONAL ENCRYPTION AT REST.
//
// ── WHY EVERY CASE SPAWNS A CHILD PROCESS ──────────────────────────────────
// PASSPHRASE is read once at module load, next to INDEX_FILE, for the same
// reason INDEX_FILE is: process configuration read at load cannot be varied
// inside a process. So each scenario here is a fresh node process with a
// scrubbed env. That is not a testing style preference — in-process variation
// would assert nothing, because the second scenario would inherit the first
// scenario's already-resolved flag and pass vacuously.
//
// The child prints a single JSON line to stdout. Everything else the module
// logs (the "starting fresh" warnings, the save warnings) goes to stderr, so a
// test can assert on BOTH the return value and the operator-visible logging
// without the two interfering.
//
// ── WHAT IS ASSERTED AND WHY ─────────────────────────────────────────────────
// The five properties that matter, each stated as the failure it prevents:
//
//   1. Round-trip       — sealed data reads back byte-identical.
//   2. Wrong key throws — and, critically, does NOT return an empty store. The
//      explicit empty-object assertions exist because the failure they guard is
//      silent: a caller that got {} would overwrite a real ledger with it.
//   3. Tamper detected  — one flipped ciphertext byte is rejected, and so is a
//      swapped auth tag. This is what the GCM tag buys over plain encryption.
//   4. Backwards compat  — a plaintext store written with the feature ABSENT
//      loads with the feature present, and vice versa. This is the Omega
//      regression: its index was written by a build that had none of this.
//   5. Not plaintext     — the claim text is NOT findable in the sealed bytes.
//      Round-trip alone would pass on a store that also leaked in the clear.
//
// Plus the invariants the feature could regress on its way in: mode stays 0600,
// atomic write still used, zero dependencies, and an unreadable PLAINTEXT store
// still degrades to empty (unchanged behaviour — the asymmetry is deliberate).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSuite } from './harness.mjs';

const { ok, section, done } = createSuite('test-encryption-at-rest.mjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLYMEM = join(REPO, 'src', 'polymem.mjs');
const GOOD = 'correct horse battery staple';

// The prelude is injected into every child: `m` is the module under test and
// `emit` is the machine-readable channel. Both live in the CHILD's scope —
// defining emit in this file would have it serialised into a function the child
// cannot see, which is exactly the "asserts nothing, looks fine" trap.
const PRELUDE = `
const m = await import(${JSON.stringify(POLYMEM)});
const emit = (v) => console.log('::R::' + JSON.stringify(v === undefined ? null : v));
`;

// Run a snippet in a fresh process with only the named env vars set.
// Returns { value, stdout, stderr }. A throw inside the child is captured, NOT
// re-thrown, so a scenario can assert on the failure instead of dying on it.
function run(script, env = {}) {
  const res = { value: undefined, stdout: '', stderr: '', threw: null };
  try {
    res.stdout = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', PRELUDE + script],
      { cwd: REPO, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
    );
  } catch (e) {
    res.threw = e;
    res.stdout = String(e.stdout || '');
    res.stderr = String(e.stderr || '');
  }
  // The child prints exactly one machine-readable line; parse it if present.
  const line = res.stdout.split('\n').find((l) => l.startsWith('::R::'));
  if (line) {
    try { res.value = JSON.parse(line.slice(5)); } catch { /* leave undefined */ }
  }
  return res;
}

// A temp store root, outside the repo (the module refuses to run inside it).
function storeRoot(tag) {
  return mkdtempSync(join(tmpdir(), `polymem-enc-${tag}-`));
}

const roots = [];
const mk = (tag) => { const r = storeRoot(tag); roots.push(r); return r; };
const cleanup = () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); };

const idxPath = (root) => join(root, 'memory', 'patterns-index.json');
const sessPath = (root, d = '2026-09-30') => join(root, 'sessions', `working-${d}.json`);

// ═══════════════════════════════════════════════════════════════════════════
section('1. round-trip with the correct key');
// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('rt');
  const out = run(`
    const i = m.loadPatternsIndex();
    i.patterns['serialize-writes-then-promote'] = {
      name: 'serialize writes then promote', domains: ['ops','code'], sessions: ['2026-09-30'],
      evidenceCount: 1, status: 'candidate',
    };
    const saved = m.savePatternsIndex(i);
    const back = m.loadPatternsIndex();
    emit({ saved, same: back.patterns['serialize-writes-then-promote'] });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });

  ok(out.value?.saved === true, 'a sealed index saves', JSON.stringify(out.stderr || '').slice(0, 200));
  ok(out.value?.same?.name === 'serialize writes then promote',
    'the correct key reads back identical data',
    JSON.stringify(out.value?.same).slice(0, 200));
  ok(out.value?.same?.evidenceCount === 1 && out.value?.same?.status === 'candidate',
    'nested fields survive the round-trip intact, not just the top-level key');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. wrong key fails loudly — and NOT with an empty store');
// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('wrongkey');
  // Write with the good key first, so the store genuinely holds real data.
  const seed = run(`
    const i = m.loadPatternsIndex();
    i.patterns['real-pattern'] = { name: 'real pattern', domains:['ops'], sessions:['2026-09-30'], evidenceCount:1, status:'candidate' };
    m.savePatternsIndex(i); emit({ ok: true });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  ok(seed.value?.ok === true, 'CONTROL: a real store exists before the wrong-key read');

  const wrong = run(`
    try {
      const back = m.loadPatternsIndex();
      emit({ returned: true, patterns: Object.keys(back.patterns || {}) });
    } catch (e) {
      emit({ returned: false, name: e.name, code: e.code, msg: e.message });
    }
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: 'the wrong passphrase entirely' });

  ok(wrong.value?.returned === false, 'a wrong passphrase THROWS instead of returning',
    JSON.stringify(wrong.value).slice(0, 200));
  ok(wrong.value?.name === 'DecryptionError', 'it throws a typed DecryptionError, not a bare Error',
    String(wrong.value?.name));
  ok(wrong.value?.code === 'DECRYPTION_FAILED', 'the error carries a machine-readable code', String(wrong.value?.code));
  ok(/passphrase/i.test(wrong.value?.msg || ''), 'the message names the actual cause (passphrase)',
    String(wrong.value?.msg).slice(0, 160));
  ok(/modified/i.test(wrong.value?.msg || ''), 'the message also names the other real cause (tampering)',
    String(wrong.value?.msg).slice(0, 160));
  ok(/cannot be recovered|lost/i.test(wrong.value?.msg || ''), 'the message states key loss is unrecoverable');

  // THE ASSERTION THAT MATTERS MOST. If any of the above regressed into
  // "return an empty index", the user would save an empty ledger over real data.
  ok(wrong.value?.patterns === undefined,
    'it does NOT return an empty index — the caller cannot mistake failure for an empty store');
  ok(!/starting fresh/.test(wrong.stderr || ''),
    'it does NOT log the "starting fresh" fallback — no soft degradation happened',
    String(wrong.stderr).slice(0, 160));

  // The data must still be there afterwards: a failed read must not have
  // rewritten anything. Byte-compare against the sealed file the good key wrote.
  const sealedBefore = readFileSync(idxPath(root));
  const after = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length });`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: 'the wrong passphrase entirely' });
  ok(after.value?.returned === false || after.value?.n === undefined,
    'a second wrong-key read also fails rather than resolving to something');
  ok(readFileSync(idxPath(root)).equals(sealedBefore),
    'the sealed file is BYTE-IDENTICAL after failed reads — a failed open never rewrites it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. tamper detection');
// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('tamper');
  run(`
    const i = m.loadPatternsIndex();
    i.patterns['p'] = { name: 'a pattern worth protecting', domains:['ops'], sessions:['2026-09-30'], evidenceCount:1, status:'candidate' };
    m.savePatternsIndex(i); emit({ ok: true });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });

  const orig = readFileSync(idxPath(root), 'utf8');

  // (a) flip one bit deep inside the base64 ciphertext
  {
    const tampered = tamperCiphertext(orig);
    ok(tampered !== null, 'CONTROL: the store is a sealed envelope, so a ciphertext byte can be flipped',
      'the file is not sealed, so there is no ciphertext to tamper with');
    // Guarded so a non-sealed file reports a failed assertion instead of writing
    // null over the store and turning every later case into a parse crash.
    if (tampered !== null) {
      writeFileSync(idxPath(root), tampered);
      const out = run(`try { m.loadPatternsIndex(); emit({ returned:true }); }
                       catch(e){ emit({ returned:false, name:e.name, code:e.code }); }`,
        { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
      ok(out.value?.returned === false, 'one flipped byte inside the ciphertext is REJECTED',
        JSON.stringify(out.value));
      ok(out.value?.code === 'DECRYPTION_FAILED', 'it surfaces as a DecryptionError, not garbage JSON');
    }
  }

  // (b) swap the auth tag — the attack GCM exists to stop
  {
    const swapped = tamperTag(orig);
    ok(swapped !== null, 'CONTROL: the store carries an auth tag to swap');
    if (swapped !== null) {
      writeFileSync(idxPath(root), swapped);
      const out = run(`try { m.loadPatternsIndex(); emit({ returned:true }); }
                       catch(e){ emit({ returned:false, code:e.code }); }`,
        { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
      ok(out.value?.returned === false, 'a swapped auth tag is REJECTED even though the ciphertext is intact');
    }
  }

  // (c) truncate — a torn or truncated file must not authenticate
  {
    writeFileSync(idxPath(root), orig.slice(0, Math.floor(orig.length / 2)));
    const out = run(`try { m.loadPatternsIndex(); emit({ returned:true }); }
                     catch(e){ emit({ returned:false, code:e.code }); }`,
      { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
    ok(out.value?.returned === false, 'a truncated sealed file is REJECTED');
  }

  // (d) restore — the control proving the rejections above were the tamper,
  //     not a broken passphrase or a broken harness.
  writeFileSync(idxPath(root), orig);
  const out = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length });`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  ok(out.value?.n === 1, 'CONTROL: the untampered original still reads back after all three tamper attempts',
    JSON.stringify(out.value));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. backwards compatibility — the regression that matters');
// ═══════════════════════════════════════════════════════════════════════════
{
  // (a) plaintext written with the feature ABSENT, read with it ABSENT.
  //     This is the Omega case exactly: an index written by a build that has
  //     never heard of this feature, loaded by one that has.
  const root = mk('compat-plain');
  const w = run(`
    const i = m.loadPatternsIndex();
    i.patterns['omega-live-pattern'] = { name:'live pattern', domains:['ops'], sessions:['2026-09-29'], evidenceCount:5, status:'established' };
    m.savePatternsIndex(i); emit({ ok:true });
  `, { OMEGA_MEMORY_INDEX: idxPath(root) });
  ok(w.value?.ok === true, 'plaintext write with the feature ABSENT still succeeds');
  ok(!readFileSync(idxPath(root), 'utf8').startsWith('POLYMEM-ENC'),
    'with no passphrase set the file is NOT sealed — the default is unchanged, byte for byte');
  ok(JSON.parse(readFileSync(idxPath(root), 'utf8')).patterns['omega-live-pattern'].status === 'established',
    'the plaintext file is still ordinary readable JSON (not an opaque blob)');

  const r = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length, s: b.patterns['omega-live-pattern'].status });`,
    { OMEGA_MEMORY_INDEX: idxPath(root) });
  ok(r.value?.n === 1 && r.value?.s === 'established',
    'a plaintext index written pre-feature loads with the feature absent');

  // (b) that same plaintext index, now read with encryption ENABLED. This is
  //     the migration path: switching encryption on must not orphan the data.
  const mig = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length, s: b.patterns['omega-live-pattern'].status });`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  ok(mig.value?.n === 1 && mig.value?.s === 'established',
    'a PLAINTEXT index still loads after the feature is switched ON — enabling does not orphan existing data',
    JSON.stringify(mig.value));
  ok(!readFileSync(idxPath(root), 'utf8').startsWith('POLYMEM-ENC'),
    'and merely READING it does not migrate or rewrite it (a read has no write side effects)');

  // (c) the next save seals it — the lazy migration, and the point at which
  //     old data actually becomes protected.
  const sealIt = run(`
    const b = m.loadPatternsIndex();
    b.meta.promotions = (b.meta.promotions || 0) + 1;
    const saved = m.savePatternsIndex(b); emit({ saved });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  ok(sealIt.value?.saved === true && readFileSync(idxPath(root), 'utf8').startsWith('POLYMEM-ENC'),
    'the next write seals a previously-plaintext index (lazy migration on write, never on read)');
  const afterSeal = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length });`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  ok(afterSeal.value?.n === 1, 'and the data is still intact after being sealed — migration is not a rewrite');

  // (d) a sealed store read with NO passphrase configured. The operator who
  //     turned encryption on and then lost the env var.
  const lost = run(`try { const b = m.loadPatternsIndex(); emit({ returned:true, n:Object.keys(b.patterns).length }); }
                    catch(e){ emit({ returned:false, code:e.code, name:e.name }); }`,
    { OMEGA_MEMORY_INDEX: idxPath(root) });
  ok(lost.value?.returned === false, 'a SEALED store read with NO passphrase fails loudly rather than returning empty');
  ok(/not set/i.test(lost.stderr || '') || lost.value?.code === 'DECRYPTION_FAILED',
    'the failure explicitly says the env var is not set', String(lost.stderr).slice(0, 200));
  ok(!/starting fresh/.test(lost.stderr || ''),
    'and it does NOT silently degrade to an empty index');

  // (e) a blank passphrase is treated as OFF, not as a key. Otherwise
  //     PASSPHRASE="" (very easy to export by accident) would "encrypt"
  //     everything under an empty key and lock the operator out of their data.
  const blank = mk('compat-blank');
  run(`const i = m.loadPatternsIndex(); i.patterns['p']={name:'p',domains:[],sessions:[],evidenceCount:0,status:'candidate'}; m.savePatternsIndex(i); emit({ok:true});`,
    { OMEGA_MEMORY_INDEX: idxPath(blank), OMEGA_MEMORY_PASSPHRASE: '   ' });
  ok(!readFileSync(idxPath(blank), 'utf8').startsWith('POLYMEM-ENC'),
    'a whitespace-only passphrase counts as OFF, so an accidental empty export cannot lock anyone out');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. the plaintext is genuinely not on disk');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A round-trip test alone cannot tell an encrypted store from one that also
  // wrote itself in the clear. This asserts the actual security property.
  const root = mk('noleak');
  const SECRET = 'A user lives at /Users/exampleuser and uses iMessage someone@example.com';
  run(`
    const i = m.loadPatternsIndex();
    i.patterns['p'] = { name: ${JSON.stringify(SECRET)}, domains:['ops'], sessions:['2026-09-30'], evidenceCount:1, status:'candidate' };
    m.savePatternsIndex(i); emit({ ok:true });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });

  const bytes = readFileSync(idxPath(root), 'utf8');
  ok(!bytes.includes(SECRET), 'the verbatim claim text does NOT appear in the sealed file');
  ok(!bytes.includes('someone@example.com'), 'nor does any fragment of it (the specific disclosure in the audit)');
  ok(!bytes.includes('/Users/exampleuser'), 'nor the home path');
  ok(bytes.startsWith('POLYMEM-ENC-V1 '), 'the file is self-identifying as sealed — an operator can tell at a glance');
  ok(!bytes.includes(GOOD), 'the passphrase does not appear in its own ciphertext');

  // The passphrase itself must never land in the file, including base64'd.
  ok(!Buffer.from(GOOD).toString('base64').includes(bytes.slice(0, 200)),
    'nor a base64 of it');

  // And the whole directory: nothing leaked to a sibling file either.
  const leaked = readdirSync(join(root, 'memory')).some((f) =>
    readFileSync(join(root, 'memory', f), 'utf8').includes(SECRET));
  ok(!leaked, 'no file in the store directory contains the plaintext');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. the session store is sealed too (uniform boundary)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('session');
  const out = run(`
    const d = '2026-09-30';
    const w = m.loadWorkingMemory(d);
    w.entries.push({ time: new Date().toISOString(), agent: 'chief', claims: [{ text: 'uses iMessage someone@example.com', domains: [] }] });
    const saved = m.saveWorkingMemory(d, w);
    const back = m.loadWorkingMemory(d);
    emit({ saved, n: back.entries.length, claim: back.entries[0].claims[0].text });
  `, { OMEGA_MEMORY_SESSIONS_DIR: join(root, 'sessions'), OMEGA_MEMORY_PASSPHRASE: GOOD });

  ok(out.value?.saved === true, 'a sealed session file saves');
  ok(out.value?.n === 1 && out.value?.claim === 'uses iMessage someone@example.com',
    'and reads back intact with the correct key');
  ok(readFileSync(sessPath(root), 'utf8').startsWith('POLYMEM-ENC'),
    'the SESSION file is sealed as well as the index — the boundary is uniform');
  ok(!readFileSync(sessPath(root), 'utf8').includes('someone@example.com'),
    'the claim text does not appear in the session file either');
  ok(existsSync(join(root, 'sessions', 'working-2026-09-30.json')),
    'the sealed session file keeps its documented filename (a reader can still find it by date)');

  // A wrong key on the session file must fail loudly too, not reset the day.
  const wrong = run(`try { const b = m.loadWorkingMemory('2026-09-30'); emit({ returned:true, n:b.entries.length }); }
                     catch(e){ emit({ returned:false, code:e.code }); }`,
    { OMEGA_MEMORY_SESSIONS_DIR: join(root, 'sessions'), OMEGA_MEMORY_PASSPHRASE: 'nope' });
  ok(wrong.value?.returned === false, 'a wrong passphrase on a session file throws rather than resetting the day');
  ok(wrong.value?.n === undefined, 'and does NOT return an empty day that the next save would overwrite');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. invariants the feature must not regress');
// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('perm');
  run(`const i = m.loadPatternsIndex(); i.patterns['p']={name:'p',domains:[],sessions:[],evidenceCount:0,status:'candidate'}; m.savePatternsIndex(i); emit({ok:true});`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });
  run(`const w = m.loadWorkingMemory('2026-09-30'); w.entries.push({time:'t',agent:'a',claims:[]}); m.saveWorkingMemory('2026-09-30', w); emit({ok:true});`,
    { OMEGA_MEMORY_SESSIONS_DIR: join(root, 'sessions'), OMEGA_MEMORY_PASSPHRASE: GOOD });

  ok((statSync(idxPath(root)).mode & 0o777) === 0o600,
    'the sealed index is still mode 0600 — encryption does not relax the permission',
    '0' + (statSync(idxPath(root)).mode & 0o777).toString(8));
  ok((statSync(sessPath(root)).mode & 0o777) === 0o600,
    'the sealed session file is still mode 0600');

  // No temp file left behind: the atomic path wrote one and renamed it.
  const strays = readdirSync(join(root, 'memory')).filter((f) => f.includes('.tmp'));
  ok(strays.length === 0, 'no .tmp file survives — the atomic write path is still used for sealed payloads',
    JSON.stringify(strays));

  // Zero dependencies, still. package.json is the contract.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  ok(!pkg.dependencies && !pkg.devDependencies && !pkg.peerDependencies,
    'package.json still declares ZERO dependencies — the headline property is intact',
    JSON.stringify({ d: pkg.dependencies, dev: pkg.devDependencies, peer: pkg.peerDependencies }));
  const srcFiles = readdirSync(join(REPO, 'src')).filter((f) => f.endsWith('.mjs'));
  // Allow `node:` builtins and relative paths; anything else is a dependency.
  // Comments are stripped FIRST: index.mjs carries a doc comment containing the
  // literal text "from 'polymem'", and scanning raw source flags the file's own
  // explanation of itself as an import. Stripping comments is what makes this
  // assert on imports rather than on prose.
  const bare = srcFiles.filter((f) => {
    const code = readFileSync(join(REPO, 'src', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return /(?:from|import)\s+['"](?![./])(?!node:)/.test(code);
  });
  ok(bare.length === 0, 'every import in src/ is either node: built-in or relative — no third-party crept in',
    JSON.stringify(bare));

  // A corrupt PLAINTEXT index still degrades to empty: unchanged behaviour,
  // deliberately asymmetric with the sealed path.
  const broken = mk('broken');
  mkdirSync(dirname(idxPath(broken)), { recursive: true });
  writeFileSync(idxPath(broken), '{ this is not json at all');
  const deg = run(`const b = m.loadPatternsIndex(); emit({ n: Object.keys(b.patterns).length });`,
    { OMEGA_MEMORY_INDEX: idxPath(broken) });
  ok(deg.value?.n === 0, 'a corrupt PLAINTEXT index still degrades to an empty index (pre-existing behaviour, unchanged)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. GCM hygiene');
// ═══════════════════════════════════════════════════════════════════════════
section('9. an ambient passphrase must not change what the other suites assert');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Regression guard for a real failure found while landing this feature.
  //
  // test-memory.mjs used to end with `JSON.parse(readFileSync(index))`, which
  // silently assumed the store on disk is plaintext. Exporting a passphrase in
  // the operator's shell — the single most natural way to use this feature —
  // then made that unrelated suite die with a bare SyntaxError on a
  // `POLYMEM-ENC-V1` header. The fix was to read back through loadPatternsIndex()
  // instead of parsing bytes. That fix was made in test-memory.mjs; what is
  // asserted here is the general property, so that "it works if you remember
  // the env var" cannot quietly come back in some other suite's raw read.
  //
  // This asserts every suite in the run passes whether or not the variable is
  // set, because the answer must not depend on ambient state.
  const withVar = spawnSync(process.execPath, [join(REPO, 'test', 'test-memory.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH, OMEGA_MEMORY_PASSPHRASE: GOOD } });
  ok(withVar.status === 0, 'CONTROL: the persistence suite is unaffected by an ambient passphrase',
    `exit=${withVar.status} ${(withVar.stderr || '').split('\n').filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 220)}`);

  // And the same file must still be readable plaintext-wise when the feature is
  // off — the loader, not a raw parse, is the contract in both directions.
  const root = mk('ambient');
  const noVar = run(`const i = m.loadPatternsIndex(); emit({ type: typeof i, n: Object.keys(i.patterns).length });`,
    { OMEGA_MEMORY_INDEX: idxPath(root) });
  ok(noVar.value?.type === 'object' && noVar.value?.n === 0,
    'a fresh index is a real object with zero patterns, not undefined (the bug this guards)',
    JSON.stringify(noVar.value));
}

// ═══════════════════════════════════════════════════════════════════════════
{
  const root = mk('gcm');
  // Both saves happen in ONE child process. The salt cache is per-process
  // module state (it has to be — there is no on-disk salt store to consult), so
  // two separate processes each generate a fresh salt for the same file. Testing
  // salt stability across processes would be asserting the opposite of the
  // design. What is being asserted here is the narrower and real claim: within
  // a process, rewriting one file reuses its salt so the scrypt derivation stays
  // cached, while the IV still changes every time.
  const twoWrites = run(`
    const i = m.loadPatternsIndex();
    i.patterns['p'] = { name:'same', domains:[], sessions:[], evidenceCount:0, status:'candidate' };
    m.savePatternsIndex(i);
    const { readFileSync } = await import('node:fs');
    const a = readFileSync(process.env.OMEGA_MEMORY_INDEX, 'utf8');
    m.savePatternsIndex(i);
    const b = readFileSync(process.env.OMEGA_MEMORY_INDEX, 'utf8');
    emit({ a, b });
  `, { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: GOOD });

  ok(!!twoWrites.value?.a && !!twoWrites.value?.b, 'two saves of identical data both produced files',
    JSON.stringify(twoWrites.stderr || '').slice(0, 200));
  const first = twoWrites.value?.a || '';
  const second = twoWrites.value?.b || '';

  ok(first !== second, 'saving identical data twice produces DIFFERENT ciphertext — no IV reuse');

  // null when the store is not sealed at all, i.e. on a build without this
  // feature. Each field assertion below is then a reported failure rather than
  // a TypeError that kills the suite partway through.
  const env1 = decodeEnvelope(first) || {};
  const env2 = decodeEnvelope(second) || {};
  ok(env1.iv !== env2.iv, 'the IV differs between writes',
    `iv1=${env1.iv} iv2=${env2.iv}`);
  ok(env1.salt === env2.salt,
    'the salt is stable per file within a process (so the scrypt derivation stays cached)',
    `salt1=${env1.salt} salt2=${env2.salt}`);
  ok(env1.kdf === 'scrypt' && env1.N >= 16384,
    'the envelope records its KDF and cost parameters, so a future default change stays readable',
    JSON.stringify({ kdf: env1.kdf, N: env1.N }));
  ok(env1.salt !== env1.iv, 'salt and IV are distinct values (a salt is not a reused IV)');
  ok(Buffer.from(env1.salt || '', 'base64').length === 16, 'the salt is 16 bytes',
    `salt=${env1.salt}`);
  ok(Buffer.from(env1.iv || '', 'base64').length === 12, 'the IV is 12 bytes (96-bit GCM standard)',
    `iv=${env1.iv}`);
  ok(Buffer.from(env1.tag || '', 'base64').length === 16, 'the auth tag is 16 bytes (full-length GCM tag)',
    `tag=${env1.tag}`);

  // A different passphrase must produce different ciphertext for the same data.
  const other = mk('gcm-other');
  run(`const i = m.loadPatternsIndex(); i.patterns['p']={name:'same',domains:[],sessions:[],evidenceCount:0,status:'candidate'}; m.savePatternsIndex(i); emit({ok:true});`,
    { OMEGA_MEMORY_INDEX: idxPath(other), OMEGA_MEMORY_PASSPHRASE: 'a different passphrase' });
  const otherBytes = readFileSync(idxPath(other), 'utf8');
  ok(otherBytes !== first, 'the same data under a different passphrase produces different ciphertext');

  // Cross-passphrase read fails.
  const cross = run(`try { m.loadPatternsIndex(); emit({returned:true}); } catch(e){ emit({returned:false}); }`,
    { OMEGA_MEMORY_INDEX: idxPath(root), OMEGA_MEMORY_PASSPHRASE: 'a different passphrase' });
  ok(cross.value?.returned === false, 'a file sealed under one passphrase cannot be read with another');
}

// ── tamper helpers ──────────────────────────────────────────────────────────
// These decode the base64 envelope and mutate a field, so they can assert on a
// GCM TAG FAILURE specifically rather than on a JSON parse error.
//
// They return null for anything that is not a sealed envelope, and the callers
// treat that as a failed assertion with a stated reason. That is deliberate: the
// obvious implementation (just JSON.parse the payload) CRASHES the suite when
// run against a build that has no encryption, at the first tamper case, and the
// process dies before reporting the remaining sections. A crashed suite proves
// less than a complete report saying which assertions cannot hold without the
// feature — and proving each test fails pre-feature is the point of running it
// against 7d9f34e at all.
function decodeEnvelope(text) {
  if (typeof text !== 'string' || !text.startsWith('POLYMEM-ENC-V1 ')) return null;
  try {
    return JSON.parse(Buffer.from(text.slice('POLYMEM-ENC-V1 '.length).trim(), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
function encodeEnvelope(env) {
  return 'POLYMEM-ENC-V1 ' + Buffer.from(JSON.stringify(env), 'utf8').toString('base64') + '\n';
}
// Flip a bit in the MIDDLE of the base64 ciphertext string. Done on the encoded
// text rather than on decoded bytes so the file stays well-formed base64 —
// otherwise the test would be measuring a JSON parse error, not a tag failure.
function tamperCiphertext(text) {
  const env = decodeEnvelope(text);
  if (!env || typeof env.ct !== 'string') return null;
  const mid = Math.floor(env.ct.length / 2);
  env.ct = env.ct.slice(0, mid) + (env.ct[mid] === 'A' ? 'B' : 'A') + env.ct.slice(mid + 1);
  return encodeEnvelope(env);
}
function tamperTag(text) {
  const env = decodeEnvelope(text);
  if (!env || typeof env.tag !== 'string') return null;
  const mid = Math.floor(env.tag.length / 2);
  env.tag = env.tag.slice(0, mid) + (env.tag[mid] === 'A' ? 'B' : 'A') + env.tag.slice(mid + 1);
  return encodeEnvelope(env);
}

cleanup();
done();
