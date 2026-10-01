// memory.mjs — Polymem — Phase 1 polymathic memory: decomposition parse, session working memory,
// patterns index, evidence-gated promotion, pattern query.
// Zero infra: Markdown + JSON on disk.
//
// CONCURRENCY. This header used to say "All writes go through the caller's
// write queue." That is true inside OmegaShell and false everywhere else, and
// the false half is what hid a real data-loss bug for a while: with no queue,
// two processes writing the same index shared ONE fixed temp path, and one
// writer's completed payload was destroyed by the other's open(O_TRUNC).
// So: writes here are atomic (unique temp + rename, see writeFileAtomic) and
// saves are MERGED under a write claim (see withIndexLock). Two processes
// saving overlapping indexes both survive. Two honest caveats: the claim only
// coordinates writers that go through this module, and counters merge by max(),
// so a concurrent pair can undercount meta.promotions by one. See README
// "Durability and privacy".
//
// Session dates are caller-supplied and become filenames, so they are validated
// against the documented YYYY-MM-DD contract at the single point of use. Keys
// derived from model output are looked up with own-property checks — a plain
// `obj[key]` on a key like "constructor" returns the inherited member of
// Object.prototype, which is truthy, and the caller then treats it as real data.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync, unlinkSync,
         openSync, closeSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep, isAbsolute, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir, hostname } from 'node:os';
import { DecryptionError, PASSPHRASE_ENV, isSealed, seal, open } from './encryption.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// Test seams: env overrides keep tests from touching the real vault/index.
//
// ── WHAT THE TRACKED patterns-index.json IS FOR ───────────────────────────────
// It is a STARTUP FILE, and it is deliberately NOT a seed corpus. The distinction
// is the whole point, so it is worth being exact rather than reassuring.
//
// The index is a live LEDGER. server.mjs:439-442 increments
// meta.decompositionStats[key] on every decomposed response, where key is
// `${agent}:${model}` — e.g. "chief:ollama/qwen2.5-coder:14b". That makes the file
// per-machine AND per-agent-identity state. It is not a shared artefact and never
// was: two deployments each have their own, and a clone does not inherit an
// honest copy of anybody's.
//
// The tracked file's actual content, measured, decides the seeding question:
//   patterns : {}            ← EMPTY. zero patterns. nothing reusable to copy.
//   promotions: 5            ← but the pattern map is empty, so those 5 were
//                               moved to quarantine-sessions/ by the last
//                               quarantine run, not deleted.
//   decompositionStats: per-agent block counters, e.g. blocks 101 / withMemory 77
//
// So seeding a fresh index from it would copy NOTHING useful and would import
// five machine-local counters. Those counters are model-attribution data: a
// fresh deployment would answer "chief decomposed 101 blocks" for an agent that
// never ran there. That is the same class of lie as an image that stamps a SHA
// it was not built from — a fabricated provenance, and it is exactly what the
// provenance gate exists to catch. Seeding is therefore REFUSED, not merely
// unhelpful, and no seed code is added here.
//
// A missing INDEX_FILE already degrades to an empty index (loadPatternsIndex),
// which is the correct fresh state. If the existing counters are wanted for a
// particular deployment, that is a one-time operator migration, not something
// code should do on every fresh start:
//
//   mkdir -p "$HOME/.computer-agent/memory"
//   cp backend/memory/patterns-index.json "$HOME/.computer-agent/memory/"
//
// Do it deliberately, once, for the deployment that actually did that work.
//
// ── WHY THE DEFAULT IS $HOME AND NOT THE REPO ─────────────────────────────────
// MEASURED, not assumed. Removing the compose bind mount was necessary but NOT
// sufficient: the mount was only how the CONTAINER reached the file. This
// constant is how anything else reaches it, and it still pointed into the
// worktree. Reproduced on the host with OMEGA_MEMORY_INDEX unset:
//
//   node -e "loadPatternsIndex(); savePatternsIndex(idx)"   → tracked file moves
//
// So the write path survived the rebuild. A local test, a manual promote, or
// any other agent's script re-dirtied the checkout, deploy.sh refused the dirty
// tree, and the sanctioned deploy was unreachable again — the same dead end,
// reached by a different door. A fix that only closes the door the container
// used is not a fix.
//
// The default is therefore $HOME/.computer-agent/memory, beside the app's other
// runtime state. The tracked file is a STARTUP FILE: read if present, never
// written. That makes the hazard structural rather than a matter of every caller
// remembering to export the right variable — which is the same reasoning as the
// git hooks in this repo: "remember to set it" is a wish, not a control.
//
// The HOME-unset fallback was `process.env.HOME || MODULE_DIR`, and MODULE_DIR is
// inside backend/memory/ — the tree being protected. With HOME unset it resolved the
// index INTO the checkout and CREATED the directory to put it there, which is
// precisely the hazard this module exists to remove. Measured 2026-09-27: the
// deployed container has HOME=/root so it never took that path, but any deployment
// without HOME silently reintroduces the dirt-tree-refuses-to-deploy dead end and
// loses the index on every rebuild.
//
// tmpdir over a hard refusal: an unset HOME is a misconfiguration, and refusing to
// boot converts a misconfiguration into an outage. A memory index is not worth an
// outage. tmpdir still keeps the write OUT of the checkout, and that is the property
// that actually matters. The cost is that the index does not survive a reboot — a
// far better failure than a deploy that can never run.
const REPO_ROOT = resolve(MODULE_DIR, '..');
const memoryBase = process.env.HOME || tmpdir();
const INDEX_FILE = process.env.OMEGA_MEMORY_INDEX
  || join(memoryBase, '.computer-agent', 'memory', 'patterns-index.json');
const SESSIONS_DIR = process.env.OMEGA_MEMORY_SESSIONS_DIR
  || join(memoryBase, 'Documents', 'Obsidian Vault', '11_COMPUTER_AGENT', 'sessions');

// Structural, not advisory. "Remember not to point this inside the repo" is a wish,
// not a control — the same reasoning as the git hooks in this repo. Both runtime
// paths are checked once, at load, and refused loudly rather than discovered later
// as an unexplained dirty tree.
//
// The second check is the one that has no guard at all today. `${process.env.HOME}/…`
// with HOME unset is not an empty path, it is the LITERAL string "undefined/…", which
// is RELATIVE and therefore resolves against process.cwd(). Measured with HOME unset
// and cwd at the repo root, that lands at:
//     <repo>/undefined/Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions
// and the recursive mkdir then creates it. A relative path is a write into the
// checkout by another name, so absoluteness is asserted rather than assumed.
// The index file usually does not exist yet, so realpath() on it alone throws. Walk
// up to the deepest existing ancestor, canonicalise THAT, and re-attach the tail —
// which is also the correct answer for a symlinked parent, the case that bit us.
function canonical(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* fall through */ }
  const tail = [];
  let dir = dirname(abs);
  for (;;) {
    try { return resolve(realpathSync(dir), ...tail); } catch { /* go up */ }
    const up = dirname(dir);
    if (up === dir) return abs;           // reached the root without finding one
    tail.unshift(basename(dir));
    dir = up;
  }
}

for (const [label, p] of [['OMEGA_MEMORY_INDEX', INDEX_FILE], ['sessions dir', SESSIONS_DIR]]) {
  if (!isAbsolute(p)) {
    throw new Error(
      `refusing to run: the ${label} is not an absolute path (${p}). With HOME unset, ` +
      '`${process.env.HOME}/…` becomes the literal string "undefined/…" and resolves ' +
      'against the current working directory — a write into the checkout. Set ' +
      'OMEGA_MEMORY_INDEX / OMEGA_MEMORY_SESSIONS_DIR to absolute paths, or set HOME.');
  }
  // Compare CANONICAL paths, not the raw strings. resolve() realpaths, and on macOS
  // /var is a symlink to /private/var, so REPO_ROOT comes back "/private/var/…"
  // while an env-supplied path stays "/var/…". A raw startsWith() then returns
  // false for a path that is demonstrably inside the repo — measured here, and the
  // guard silently did nothing. A containment check that fails to contain is worse
  // than no check, because it is believed.
  if (canonical(p) === canonical(REPO_ROOT) || canonical(p).startsWith(canonical(REPO_ROOT) + sep)) {
    throw new Error(
      `refusing to run: the ${label} resolves INSIDE the checkout (${p}). Runtime state ` +
      'must live outside the repo — a write here re-dirties the tree and makes the ' +
      'sanctioned deploy unreachable.');
  }
}

// ── Encryption at rest (OPT-IN, off by default) ────────────────────────────────
// Read the passphrase at LOAD, next to INDEX_FILE, for the same reason INDEX_FILE
// is read at load: it is process configuration, and a value that can change
// mid-process produces a store whose files disagree about who wrote them.
// Unset or blank means OFF, which is the state every existing user is in — so
// their bytes on disk are byte-identical to before this feature existed.
//
// ── WHY BOTH STORES, AND WHY THAT IS NOT OBVIOUS ─────────────────────────────
// The task framing was "encrypt the index", and encrypting only the index would
// have been a mistake that still looked like a pass. The finding this task quotes
// was a CLAIM — "A user lives at /Users/exampleuser and uses iMessage
// someone@example.com" — and a claim does not enter the index directly. It
// enters through loadWorkingMemory in promoteSession (:908), which reads the
// SESSION file. So with the index sealed and the session file in the clear, the
// plaintext of every promoted pattern still sits on disk in working-*.json,
// verbatim, and the seal protects a summary of a secret rather than the secret.
//
// Encrypting exactly one of the two is worse than encrypting neither, because it
// buys the appearance of the guarantee while the disclosure stays one file over.
// So the boundary is: every byte Polymem writes to either store is sealed or
// neither is. Off means both plaintext (unchanged). On means both sealed. There
// is no reachable state where the index is sealed and a session file is not,
// because the flag is read once and both writers consult it.
//
// THE COROLLARY, WHICH IS THE ACTUAL COST: turning encryption on does not
// retroactively seal session files written before it was switched on. Those stay
// plaintext until they are next written. An operator who sets the env var on a
// store with history should be told that plainly rather than discovering it from
// an audit.
//
// ── WHY THE READ PATH IS THE DANGEROUS PART ─────────────────────────────────
// loadPatternsIndex below was written to be unfailable: try, catch, log, return
// a fresh empty index. That is correct for a MISSING file and correct for a
// corrupt one, and it is catastrophic for a wrong key, because the failure is
// not "no data" — it is "I could not read the data, and here is an empty index,
// and the next savePatternsIndex will now overwrite your real ledger with it."
//
// That is silent, unrecoverable data loss, and it would be INTRODUCED by this
// feature: the same code that cannot read the file would happily destroy it. So
// DecryptionError is rethrown from the catch and never converted to an empty
// index. The catch still handles the plaintext cases it always did. A caller
// that gets an exception knows to stop; a caller that gets {} believes it is
// looking at an empty store and destroys a full one.
//
// Note the asymmetry this creates, deliberately: a CORRUPT plaintext index still
// degrades to empty (unchanged, and the user is told on stderr), while a
// SEALED file that will not open is fatal to the read. Failing soft on the
// unsealed path preserves every existing behaviour; failing soft on the sealed
// path is the data-loss case above.
const PASSPHRASE = process.env[PASSPHRASE_ENV];
const ENCRYPTION_ENABLED = typeof PASSPHRASE === 'string' && PASSPHRASE.trim() !== '';

// Per-file salt, remembered so a rewrite of the SAME file keeps its salt and the
// scrypt derivation can be cached (25ms is not a cost worth paying on a
// per-response write path). Held in memory only — never written outside the
// sealed file itself, where it is stored as part of the envelope. Losing this
// map costs one extra derivation, not correctness: a fresh salt is a valid salt.
const saltByFile = new Map();

function saltForFile(file) {
  let salt = saltByFile.get(file);
  if (!salt) { salt = randomBytes(16); saltByFile.set(file, salt); }
  return salt;
}

// Seal on the way out. writeFileAtomic is called with the SEALED string, so the
// unique-temp-plus-rename path and the 0600 mode are unchanged — the mode is set
// on the temp file before rename, which is still the only moment that matters,
// and it applies to ciphertext with exactly the same force it applied to
// plaintext. There is no window in which plaintext exists in the temp file.
//
// The JSON.stringify happens BEFORE seal(), so the sealed bytes never contain a
// readable key name, let alone a value.
function writeStoreAtomic(target, value) {
  writeFileAtomic(target, encodeStore(target, value));
}

// Encode a value to exactly the bytes a store file should contain: JSON, sealed
// first when encryption is on. Split out from writeStoreAtomic so the
// read-modify-write path can ENCODE inside the write claim and still publish
// through writeFileAtomic.
//
// This exists because the two features meet here. The concurrent-merge path
// takes the claim, re-reads, merges, and writes — and if that path composed its
// own payload it would have to remember to seal. A writer that forgot would put
// the memory index on disk in PLAINTEXT while the operator believed it was
// encrypted, and it would do so silently, because a plaintext index is a valid
// index. One encode function, called by every store writer, is the only version
// of that which cannot drift.
function encodeStore(target, value) {
  const json = JSON.stringify(value, null, 2);
  return ENCRYPTION_ENABLED ? seal(json, PASSPHRASE, saltForFile(target)) : json;
}

// Read a store file and return its decoded JSON, or ABSENT when the file is
// missing or unreadable in the plaintext sense.
//
// ABSENT is a symbol rather than null ON PURPOSE. The original code returned
// null-or-undefined from the same expression and the callers coalesced it with
// `||`, which means "the file contained null/false/0" and "the file is not
// there" become the same answer. A store file containing a bare `null` would be
// reported as absent and then silently replaced with a fresh empty index on the
// next save. A sentinel makes the two cases unrepresentable as each other.
const ABSENT = Symbol('polymem.store-absent');

function readStore(target, label) {
  let text;
  try {
    if (!existsSync(target)) return ABSENT;
    text = readFileSync(target, 'utf8');
  } catch (e) {
    console.error(`${label} unreadable, starting fresh:`, e.message);
    return ABSENT;
  }

  // Sealed files are detected by their magic prefix, never by trying a decrypt.
  // A decrypt attempt as a *test* is what makes a wrong key indistinguishable
  // from a corrupt file; a prefix test is unambiguous in both directions.
  if (isSealed(text)) {
    // No passphrase configured but a sealed file is present: this is the
    // operator who turned encryption on, restarted, and lost the env var.
    // Returning null here would hand back an empty index and invite the next
    // save to overwrite a sealed store with plaintext. It must be loud.
    if (!ENCRYPTION_ENABLED) {
      throw new DecryptionError('no-key', label);
    }
    // Throws DecryptionError on a wrong passphrase or a modified file. It is
    // deliberately NOT caught here — see the block comment above.
    return JSON.parse(open(text, PASSPHRASE, label));
  }

  // Plaintext. Returned whether or not encryption is enabled, so a store
  // written before the feature existed keeps loading after it is switched on.
  // That is the migration path, and it is also the reason a store can be
  // half-migrated: existing files stay plaintext until they are next written,
  // at which point the SAME writer seals them. Nothing is rewritten eagerly,
  // because an eager migration pass would be a write to every file on first
  // read — a destructive side effect of a read.
  return JSON.parse(text);
}

// ── Atomic write ──────────────────────────────────────────────────────────
// WHY THIS EXISTS. Both writers built a FIXED, PREDICTABLE tmp name —
// `INDEX_FILE + '.tmp'` and `p + '.tmp'`. Two processes writing at once then
// shared one temp file: writer B's open(O_TRUNC) wiped the bytes writer A had
// just written, and whoever called rename() last published THEIR payload while
// the other's entire payload was discarded. Measured here, 5 concurrent
// processes x 600 patterns each, expected 3000 patterns:
//
//   between 600 and 2400 patterns landed (most often 1200), so between 1 and 4
//   of the 5 writers were represented at all. Every process reported
//   saved:true.
//
// The count is a RACE outcome and moves with scheduling, so it is recorded as a
// range over 30 runs. This comment previously asserted the single worst run
// (600 patterns, 1 writer) as if it were the invariant — a point estimate of a
// race, which is not a measurement.
//
// The header comment used to claim "All writes go through the caller's write
// queue." That is true inside Omega and false everywhere else — a consumer
// running two instances of this library has no such queue.
//
// WHAT THE FIX DOES AND DOES NOT DO. A unique tmp name per write means no
// writer can truncate another's in-flight payload, and rename() stays atomic
// (POSIX, same filesystem) so a reader sees either the old file or the new one.
// That makes each SAVE atomic and non-corrupting.
//
// It does NOT make concurrent saves MERGE on its own, and this comment used to
// claim that merging was impossible. It was wrong: the tmp path was never the
// obstacle, the missing read-modify-write cycle was. savePatternsIndex now takes
// the write claim, re-reads the file INSIDE it, and merges the caller's
// snapshot with what is actually on disk before committing (withIndexLock,
// mergeConcurrentIndex). The unique tmp name and this rename are the commit
// half of that; they were always necessary and are unchanged.
//
// The separation is deliberate: the tmp name prevents corruption, the merge
// prevents lost updates. A library can fix either alone — this one had fixed
// only the first for a while, which is why the file was never torn and the
// patterns still disappeared.
//
// The counter is per-process and the random suffix is per-call, so two writes
// from the SAME process in the same millisecond still differ.
let writeCounter = 0;
function uniqueTmpPath(target) {
  writeCounter += 1;
  const salt = randomBytes(6).toString('hex');
  return `${target}.${process.pid}.${writeCounter}.${salt}.tmp`;
}

// 0600, not the 0644 that writeFileSync's default produces. The index and the
// session files hold agent output verbatim: absolute paths, provider and model
// names, task ids, agent identity, and whatever a user's claim happened to
// contain. Those are other people's data, and on a shared or multi-user machine
// a world-readable memory file is a disclosure bug rather than a style choice.
//
// The mode must be set on the TMP file, because rename() preserves the mode of
// the file it renames — setting it on the destination after the rename would be
// a window in which the file is already public.
const PRIVATE_FILE_MODE = 0o600;

// Write atomically. Throws on failure with the caller's own error, so the
// existing per-caller catch and warn-once policy is unchanged.
function writeFileAtomic(target, contents) {
  const tmp = uniqueTmpPath(target);
  try {
    writeFileSync(tmp, contents, { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, target);
  } catch (e) {
    // Clean up the temp file so a failed write does not leave a partial index
    // sitting next to the real one. Best-effort: if the write itself failed
    // there may be nothing to remove, and that is not a second error.
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// ── Read-modify-write safety (the lost-update fix) ─────────────────────────
//
// THE BUG THIS KILLS. writeFileAtomic makes ONE write atomic. It says nothing
// about the cycle around it, and the cycle is where the data died. Two
// processes each call loadPatternsIndex(), each add their own pattern, each
// savePatternsIndex(): both read the same valid index, both write a complete
// snapshot, and the second rename publishes a file that does not contain the
// first process's pattern. Not corruption — SILENT LOSS, with both writers
// reporting success. Measured on the pre-fix code, 8 concurrent processes each
// adding one distinct pattern, released together off a barrier:
//
//   between 1 and 7 of 8 present (most often 3 of 8), valid JSON,
//   all 8 reported saved:true in every run
//
// The count is a RACE outcome and moves with scheduling, so it is recorded as a
// range over 120 runs. An earlier version of this comment asserted a single
// figure (5 of 8) that no longer reproduced; a point estimate here was false
// precision, not a measurement.
//
// WHY PURE OPTIMISTIC CONCURRENCY IS NOT ENOUGH — measured, not assumed.
//
// The obvious fix is textbook optimistic concurrency: read the file, hash it,
// mutate, re-read and compare the hash, and only then rename. It was
// implemented faithfully and it FAILED, three runs of 8 writers:
//
//   present 2 of 8 (LOST 6) / present 3 of 8 (LOST 5) / present 1 of 8 (LOST 7)
//
// every one reporting saved:true. The reason is that this check is not atomic
// with the commit it is supposed to protect:
//
//   A: verify disk == what I read   ✓ passes
//   B:                                  rename B's snapshot        ← A is now stale
//   A:                                  rename A's snapshot        ← B's work GONE
//
// POSIX rename() is UNCONDITIONAL. There is no "rename only if the destination
// still has the bytes I read", and no way to spell one with Node's stdlib
// (linkat2/RENAME_NOREPLACE is Linux-only and not exposed; macOS renamex_np is
// not in Node). So the verify step and the rename can always be interleaved,
// and the window is exactly the width of the second read. Optimistic
// concurrency narrows the window from "the whole read-modify-write" to "one
// stat + one read" — which is why it sometimes looks like it works — and that
// is a probability improvement, not a guarantee. A data-loss fix that is
// usually fine is the bug again with extra steps.
//
// WHY NOT flock. The task brief's objection to a lock is portability and it is
// correct: flock(2) does not exist on Windows, and quietly narrowing the
// supported platform to POSIX is not a decision to make by accident. The fix
// below keeps the brief's optimistic SHAPE — verify before writing, bounded
// retries, no long-held lock — while making the verify+commit pair actually
// atomic, using a primitive that exists on every platform Node runs on:
//
//   open(path, 'wx')   → O_CREAT|O_EXCL. Atomic create-if-absent. Succeeds for
//                        exactly one caller; every other gets EEXIST.
//
// That is a compare-and-swap. It is a claim, not a mutex held across user code:
// it is taken, the write happens, it is released — microseconds — and it is
// released in a finally, so a throw inside the write path cannot strand it.
//
// THE CLAIM IS SELF-HEALING, which is what separates this from the lockfile
// pattern the brief rightly distrusted. A plain lockfile survives a crash and
// wedges the index forever, needing manual recovery. This one records its
// owner's pid and hostname, so a claim whose process is provably dead is broken
// automatically. Measured here: process.kill(pid, 0) throws ESRCH for a dead
// pid and returns normally for a live one, which is the liveness test.
//
// The stale-break is deliberately CONSERVATIVE, because a wrong "this owner is
// dead" verdict is a double-writer, which is the exact bug being fixed:
//   - a claim from a DIFFERENT host is never broken on age alone (we cannot
//     check a pid on a machine we are not on; NFS/SMB pid namespaces make it
//     meaningless), so it is left to expire on the bounded-retry deadline;
//   - a claim from THIS host is broken on age only if its pid is dead;
//   - a claim that is merely OLD is not broken if its pid is alive, however
//     long it has been held — a slow writer is never declared dead.
//
// NEVER HANGS. Every wait is a synchronous Atomics.wait sleep (this module is
// fully synchronous, so a busy spin would burn a core and a setTimeout would
// not run at all), and the retry loop is bounded by both an attempt count and a
// wall-clock deadline. On exhaustion it throws ContentionError, which names the
// file, the attempts, and what to do — a caller that gets a clean, actionable
// error can retry or serialize; a caller that gets a hang cannot do anything
// at all, and a hang inside Omega's per-response write path would take the
// request down with it.
//
// RE-ENTRANCY. The claim is per-target, not global, and this module can nest:
// promoteSession() saves, and a caller's mutate callback may save too. A plain
// lock would deadlock against itself. Claims held by THIS process are tracked,
// so a nested acquire of a target we already hold runs the body directly. That
// is sound precisely because this is single-threaded synchronous code: no other
// task can interleave between the check and the run.

// Bounded on both axes: attempts for a fast clean failure, and a wall-clock
// deadline so a pathological writer cannot stretch the wait indefinitely.
const CLAIM_MAX_ATTEMPTS = 64;
const CLAIM_TIMEOUT_MS = 5_000;
// Above this a claim is only broken if its owner is ALSO provably dead (see
// the conservatism note above). 30s is far longer than any real critical
// section here, which is a stat, a read, and a rename.
const CLAIM_STALE_MS = 30_000;
const CLAIM_POLL_MIN_MS = 1;
const CLAIM_POLL_MAX_MS = 25;

export class ContentionError extends Error {
  constructor(target, attempts, elapsedMs, detail = {}) {
    super(
      `could not acquire the write claim for ${target} after ${attempts} attempt(s) over ` +
      `${elapsedMs}ms. Another process is writing this file and did not release it. ` +
      'Nothing was written and nothing was lost. Retry the operation, or serialize your ' +
      'writes through a single queue if this recurs.' +
      // B4: say the useful thing when the holder is provably gone. "Another
      // process is writing this file" is not true and not actionable for a
      // claim whose owner died — the correct advice is "it becomes breakable in
      // N seconds", which is also the reason we did not wait.
      (detail.holder === 'dead'
        ? ` The holder (pid ${detail.pid}) is not running, so this cannot be waited out: ` +
          `its claim is deliberately left in place and becomes breakable in about ` +
          `${detail.waitsSeconds}s. Nothing was written and nothing was lost.`
        : ''));
    this.name = 'ContentionError';
    this.code = 'CONTENDED';
    this.target = target;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

// This module is synchronous throughout, so a non-blocking sleep would spin a
// core. Atomics.wait parks the thread and is available on the main thread
// (verified here) — and unlike setTimeout it actually runs before the next
// line, which a synchronous function needs.
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const hashOf = (text) => createHash('sha256').update(text).digest('hex');

// Identity of a claim we own. Scoped per-process and per-target: the Set is
// what makes a nested acquire of an already-held target run inline instead of
// deadlocking, and it is safe ONLY because this module is synchronous — a
// concurrent task could never be mid-critical-section on another thread.
const heldClaims = new Set();

const claimPathFor = (target) => `${target}.claim`;

// Take the claim, or throw ContentionError. Returns a release function.
function acquireClaim(target, { maxAttempts = CLAIM_MAX_ATTEMPTS, timeoutMs = CLAIM_TIMEOUT_MS } = {}) {
  if (heldClaims.has(target)) return () => {};       // re-entrant: we already own it
  const claim = claimPathFor(target);
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      // O_CREAT|O_EXCL. The one atomic primitive that makes this a CAS rather
      // than a hopeful check. 'wx' is the documented Node spelling and is not
      // POSIX-specific.
      const fd = openSync(claim, 'wx', PRIVATE_FILE_MODE);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      heldClaims.add(target);
      return () => {
        heldClaims.delete(target);
        // Best-effort cleanup. If this throws the claim is already gone or the
        // directory is unwritable; the stale-breaker below recovers either way,
        // so swallowing here cannot wedge the index.
        try { unlinkSync(claim); } catch { /* recovered by staleness handling */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;              // a real I/O failure, not contention
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) throw new ContentionError(target, attempts, elapsed);
      if (attempts > maxAttempts) throw new ContentionError(target, attempts, elapsed);
      const expected = readClaimIdentity(claim);
      if (expected && isClaimStale(claim, expected)) {
        // A claim judged stale is not authority to delete. Between the check
        // and this unlink, the holder may have released it and a DIFFERENT
        // process may have acquired it. Unlinking unconditionally deletes a
        // LIVE holder's claim and puts two writers inside the section at once
        // — the lost update this mechanism exists to prevent. Measured on this
        // file: the blind unlink lost writes in 3 of 40 eight-writer runs, with
        // every writer reporting saved:true.
        //
        // So break the claim only if it is still the SAME one judged stale. If
        // it changed, someone owns it now and it must be left alone.
        //
        // HONEST SCOPE: read-compare-unlink is not itself atomic, so this
        // narrows the window rather than proving it closed. The residual race
        // needs a claim replaced by a live one within a few microseconds. The
        // previous code needed only a momentary stat failure, which this
        // machine produces routinely. Narrower is the truthful claim; do not
        // upgrade it to "impossible" without a measurement that shows it.
        breakClaimIfUnchanged(claim, expected);
        continue;
      }
      // B4: the holder is GONE, but not yet old enough for the rule above to
      // break its claim. That is the one state where waiting cannot help: the
      // claim becomes breakable at (mtime + CLAIM_STALE_MS) and no amount of
      // polling inside a 5s budget will reach it. Measured before this check
      // existed — 2295ms, 2474ms, 2817ms of BLOCKED event loop per write, all
      // of it spent sleeping on a claim whose owner was provably dead and
      // which could not be touched for another ~30s.
      //
      // So fail fast, with a message that says WHY it cannot be waited out.
      // The staleness rule is untouched: we do not break this claim, we refuse
      // to spin on it. A holder that might still release — a live pid, or any
      // claim we cannot prove dead — skips this and keeps being waited on
      // exactly as before.
      if (expected && isClaimAbandonedButUnbreakable(expected)) {
        const age = Math.max(0, Date.now() - (expected.mtime || Date.now()));
        const waits = Math.ceil((CLAIM_STALE_MS - age) / 1000);
        throw new ContentionError(target, attempts, elapsed, {
          holder: 'dead', pid: expected.info?.pid, waitsSeconds: waits,
        });
      }
      // Jittered backoff. A fixed interval makes N contending writers wake
      // together and collide again, which turns a bounded wait into a livelock.
      sleepSync(CLAIM_POLL_MIN_MS + Math.floor(Math.random() * CLAIM_POLL_MAX_MS));
    }
  }
}

// Snapshot everything about a claim that identifies WHICH claim this is, so a
// later decision to break it can be checked against the same claim rather than
// against whatever happens to be at the path by then.
//
// `body` is the raw file content. Two claims by the same pid are still different
// claims, and the body carries the `at` timestamp that distinguishes them.
// `mtime` is null when the file cannot be stat'd at all, which is the race the
// breaker must not treat as permission to delete.
function readClaimIdentity(claim) {
  let body = null;
  let mtime = null;
  try { body = readFileSync(claim, 'utf8'); } catch { body = null; }
  try { mtime = statSync(claim).mtimeMs; } catch { mtime = null; }
  let info = null;
  if (body !== null) { try { info = JSON.parse(body); } catch { info = null; } }
  return { info, mtime, body };
}

// Break the claim ONLY if it is still the same claim that was judged stale.
// Returns true if the path was cleared, false if the claim changed underneath us
// (someone released it and a live writer re-acquired) and was therefore left
// alone.
function breakClaimIfUnchanged(claim, expected) {
  const now = readClaimIdentity(claim);
  // Unchanged means the same bytes at the same mtime. A re-acquired claim has a
  // different `at` and a fresh mtime, so this comparison catches the swap.
  if (now.body !== expected.body || now.mtime !== expected.mtime) return false;
  try { unlinkSync(claim); return true; } catch { return false; }   // someone beat us to it
}

// Is this claim abandoned? Conservative in both directions — see the block
// comment above. Returns true ONLY when breaking it is safe.
function isClaimStale(claim, identity) {
  const { info, mtime, body } = identity;
  if (body === null) {
    // Unreadable or half-written claim. A writer creates it with O_EXCL and
    // writes the body immediately, so a zero-length file is a writer caught
    // mid-write. Treat it as young unless it is genuinely old.
    //
    // The "vanished under us" case is the one that used to return true and cost
    // us a lost write: a claim that cannot be stat'd is not evidence of an
    // ABANDONED claim, it is evidence that we raced the holder's release. The
    // unlink it authorised is what deleted the next holder's live claim. It now
    // returns false, and the contention path simply retries the O_EXCL create,
    // which is the correct response to "I could not see it".
    if (mtime === null) return false;
    return Date.now() - mtime > CLAIM_STALE_MS;
  }
  if (!info || typeof info !== 'object') return false;
  if (!info || typeof info !== 'object') return false;
  // A claim from another host: we cannot check that pid, and on NFS/SMB the
  // pid namespace is not ours to interpret. Age alone is not enough evidence.
  if (info.host !== hostname()) return false;
  if (!Number.isInteger(info.pid)) return false;
  if (info.pid === process.pid) return false;         // ours, under a different target
  let alive;
  try { process.kill(info.pid, 0); alive = true; } catch (err) { alive = err.code !== 'ESRCH'; }
  if (alive) return false;                            // a slow writer is never dead
  return Date.now() - mtime > CLAIM_STALE_MS;         // dead AND old
}

// Is this claim abandoned — the owner provably gone — but still too YOUNG to
// break? The one state where waiting is provably futile.
//
// Deliberately built from the SAME predicates isClaimStale uses, by delegating
// to it: dead-and-old returns false from isClaimStale and from here, and so
// does a claim we cannot judge (live pid, foreign host, unreadable). The only
// inputs are the same {info, mtime, body} snapshot, so the two can never drift
// into disagreeing about who owns a file — which would mean the waiter and the
// breaker evaluate different facts about the same claim.
//
// Note the two-argument call. isClaimStale(claim, identity) keeps the path for
// its own error message; this helper already holds the path's snapshot and
// passes identity second, matching how the acquire loop calls it.
function isClaimAbandonedButUnbreakable(identity) {
  const { info, mtime, body } = identity;
  // Already breakable: the caller handles that on the branch above.
  if (isClaimStale(null, identity)) return false;
  if (body === null || mtime === null) return false;
  if (!info || typeof info !== 'object') return false;
  if (info.host !== hostname()) return false;   // cannot prove a foreign pid dead
  if (!Number.isInteger(info.pid)) return false;
  if (info.pid === process.pid) return false;
  let alive;
  try { process.kill(info.pid, 0); alive = true; } catch (err) { alive = err.code !== 'ESRCH'; }
  return !alive;   // provably gone, but too young to break. Waiting cannot help.
}

// Run `mutate` against the CURRENT on-disk contents and commit, atomically with
// respect to every other process using this file.
//
// Read the on-disk bytes of a store for the purposes of this lock: hashed
// exactly as they are on disk, but DECODED for the mutator, because with
// encryption on the bytes are a sealed envelope and JSON.parse would throw on
// it. The mutator always sees the logical index; it never has to know whether
// the store happens to be sealed.
function readStoreBytes(target, label) {
  if (!existsSync(target)) return { raw: null, value: null };
  const raw = readFileSync(target, 'utf8');
  let value = null;
  try {
    const decoded = readStore(target, label);
    value = decoded === ABSENT ? null : decoded;
  } catch {
    // A store we cannot decode (sealed and unopenable, or unparseable) is left
    // as null so the caller's snapshot wins rather than being replaced by a
    // value we did not actually read. readStore already logged or threw with
    // the real reason; swallowing it here must not turn into a silent clobber.
    value = null;
  }
  return { raw, value };
}

// This is the read-modify-write primitive the save functions could not be on
// their own.
//
// The mutator is re-run on every retry, so it MUST be idempotent and must
// derive everything it writes from the index it is handed. A mutator that
// closes over stale state defeats the whole mechanism.
//
// The mutator returns an already-ENCODED payload (see encodeStore) because that
// is the only way the sealing decision stays in one place; writeFileAtomic then
// publishes those bytes with the unique-temp + rename path and the 0600 mode.
export function withIndexLock(target, mutate, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? CLAIM_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? CLAIM_TIMEOUT_MS;
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    // Release exactly once per acquire. Doubling up is not harmless: after our
    // own unlink, another process can legitimately take the claim, and a second
    // release would delete THEIRS — manufacturing the double-writer this whole
    // mechanism exists to prevent. Hence `released`, and a `finally` that
    // respects it.
    const release = acquireClaim(target, { maxAttempts, timeoutMs });
    let released = false;
    const releaseOnce = () => { if (!released) { released = true; release(); } };
    try {
      // Read INSIDE the claim. Reading before acquiring would reintroduce
      // exactly the lost update this exists to prevent: the window between the
      // read and the claim is a window in which another writer's commit is
      // missed entirely.
      //
      // Hashed on the RAW bytes, not the decoded value, and that is deliberate.
      // With encryption on, seal() mints a fresh random IV on every call, so
      // re-encoding identical content yields different bytes. Hashing the
      // decoded value would report "unchanged" for a file another writer had
      // genuinely rewritten, and the verify would pass over a real change.
      // Hashing the bytes detects any write, which is what the check is for.
      const { raw: currentRaw, value: currentValue } = readStoreBytes(target, opts.label ?? target);
      const before = hashOf(currentRaw ?? '');
      const next = mutate(currentValue);

      // THE OPTIMISTIC VERIFY, and it is not redundant with the claim.
      // The claim coordinates writers that go through this module. It cannot
      // coordinate a human with an editor open on the file, a backup restore, or
      // a second tool entirely — and one of those overwriting us is exactly the
      // silent loss this whole mechanism exists to prevent. Re-reading the hash
      // right before the commit catches that, and retries on top of their
      // result instead of erasing it.
      const stillOnDisk = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (hashOf(stillOnDisk ?? '') !== before) {
        if (attempt >= maxAttempts) {
          throw new ContentionError(target, attempt, Date.now() - started);
        }
        // Yield before retrying: a non-cooperating writer will not wait for us,
        // and holding the claim only prolongs the overlap.
        releaseOnce();
        sleepSync(CLAIM_POLL_MIN_MS + Math.floor(Math.random() * CLAIM_POLL_MAX_MS));
        continue;
      }

      // `next === null` means "I looked and there is nothing to write" — for
      // callers that want the claim around a read-modify-decide cycle.
      if (next !== null) writeFileAtomic(target, next);
      return next;
    } finally {
      releaseOnce();
    }
  }
}


// ── Fixed domain vocabulary (prevents "code"/"coding"/"engineering" fragmentation) ──
const DOMAIN_VOCAB = ['code', 'research', 'design', 'ops', 'finance', 'comms', 'other'];
const DOMAIN_SYNONYMS = {
  coding: 'code', engineering: 'code', programming: 'code', dev: 'code', software: 'code', tech: 'code', technical: 'code',
  science: 'research', scientific: 'research', academic: 'research', investigation: 'research',
  ui: 'design', ux: 'design', visual: 'design', art: 'design', aesthetic: 'design', aesthetics: 'design',
  infrastructure: 'ops', infra: 'ops', devops: 'ops', system: 'ops', systems: 'ops', operations: 'ops',
  money: 'finance', budget: 'finance', investment: 'finance', investing: 'finance', financial: 'finance',
  communication: 'comms', messaging: 'comms', email: 'comms', writing: 'comms',
};

export function normalizeDomain(raw) {
  const d = String(raw || '').trim().toLowerCase();
  if (DOMAIN_VOCAB.includes(d)) return d;
  return DOMAIN_SYNONYMS[d] || 'other';
}

// The index key for a pattern name.
//
// THE TRUNCATION WAS A TRUST DEFECT, NOT A COSMETIC ONE. This used to be:
//
//   String(name).toLowerCase().replace(/[^a-z0-9]+/g,'-')
//     .replace(/^-+|-+$/g,'').slice(0,60) || 'unnamed-pattern'
//
// `slice(0,60)` threw away the tail of the identity, so two DIFFERENT patterns
// that shared their first 60 slug characters collapsed onto one key. Measured:
// two unrelated long names both produced
//   "atomic-rename-publishes-a-whole-file-or-nothing-so-a-crash-m"
// and three sessions — one of ALPHA, two of BETA — accumulated onto that single
// entry, which then crossed the 3-session bar at status=established. A pattern
// reached ESTABLISHED on the strength of a fact it had never been stated in,
// and its nameVariations list stayed empty, so even the audit trail did not
// record that two different things had been fused.
//
// The near-duplicate guard could not catch it: that guard matches on token
// CONTAINMENT (>= 0.9) and these two names score 0.758 — correctly judged
// DIFFERENT — while the id function had already thrown the difference away.
// "Different enough to not merge" and "identical after truncation" are not in
// tension; the id is the defect.
//
// THE FIX. A name that fits inside the budget keeps its exact historical id,
// so every existing stored index keeps working untouched. A name that does NOT
// fit gets its first MAX_PATTERN_ID chars plus a short hash of the FULL slug,
// so the discarded tail is part of the identity. Two names that differed only
// after character 60 now differ in the digest. Bounded AND unique.
const MAX_PATTERN_ID = 60;
// 8 hex chars of SHA-256 over the full slug: 32 bits, which for a corpus of
// this size makes an accidental collision negligible, and the cost of a
// collision is now a missed merge rather than fabricated corroboration.
const PATTERN_ID_DIGEST_CHARS = 8;

const patternSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ── Domain inference (W1) ──────────────────────────────────────────────────
// THE SILENCE WAS THE BUG. `established` requires 3 sessions AND 2 domains,
// and the domain half was reachable only if the model wrote a prose suffix in
// its memory fence:
//
//   - Serialize-then-write under concurrency — domains: code, ops
//
// If it doesn't — which is a documentation detail, not a contract it can be
// relied on to honour — a pattern can never reach `established`. It sits at
// `candidate` forever while `meta.promotions` climbs and `meta.patternGate`
// reports every single one ACCEPTED. Nothing anywhere said why. Measured on the
// shipped real-corpus fixture: 20 of 26 real pattern lines carry only ONE
// domain, and the corpus could not produce a single established pattern at all.
// The product's central promise was silently absent, with a healthy-looking
// meta bag as the only evidence.
//
// THE FIX IS INFERENCE FROM THE FILE'S OWN VOCABULARY, NOT A SCORER. The
// vocabulary already exists: DOMAIN_VOCAB and DOMAIN_SYNONYMS above, plus the
// tokenizer below. Nothing is added and nothing is learned.
//
// WHAT THIS IS NOT. It is not a positive scorer, and deliberately so. The
// calibration corpus contains no real contradictions, so any "this looks like
// knowledge" threshold would be fitted to noise — the team refused one on those
// grounds and that decision is left intact. Inference supplies a MISSING
// domain; it never grants the 2-domain bar on its own. A pattern whose text
// names no domain at all stays at `candidate`, and now says so in meta.
const DOMAIN_HINTS = {
  // code — the vocabulary a technical pattern actually uses, which is rarely
  // the word "code" itself. Kept deliberately small and literal: each entry is
  // a word that would be a false negative without it, not a topical guess.
  write: 'code', writes: 'code', writing: 'code', rewrite: 'code', serialize: 'code',
  serialized: 'code', concurrency: 'code', concurrent: 'code', atomic: 'code',
  rename: 'code', transaction: 'code', transactional: 'code', idempotent: 'code',
  mutex: 'code', lock: 'code', locking: 'code', deadlock: 'code', race: 'code',
  buffer: 'code', compile: 'code', compiler: 'code', code: 'code', sql: 'code',
  database: 'code', index: 'code', schema: 'code', api: 'code', function: 'code',
  module: 'code', thread: 'code', process: 'code', file: 'code', json: 'code',
  parse: 'code', parser: 'code', encoding: 'code', algorithm: 'code', data: 'code',
  // ops
  deploy: 'ops', deployment: 'ops', production: 'ops', prod: 'ops', server: 'ops',
  host: 'ops', hosts: 'ops', disk: 'ops', cron: 'ops', queue: 'ops', deploys: 'ops',
  infra: 'ops', pipeline: 'ops', runtime: 'ops', deploy: 'ops', service: 'ops',
  incident: 'ops', rollback: 'ops', restart: 'ops', node: 'ops', nginx: 'ops',
  // design
  layout: 'design', visual: 'design', css: 'design', typography: 'design',
  color: 'design', colour: 'design', spacing: 'design', mockup: 'design',
  // research
  hypothesis: 'research', study: 'research', experiment: 'research', evidence: 'research',
  literature: 'research', paper: 'research', analysis: 'research', benchmark: 'research',
  // finance
  cost: 'finance', pricing: 'finance', revenue: 'finance', spend: 'finance',
  invoice: 'finance', budget: 'finance', margin: 'finance',
  // comms
  user: 'comms', users: 'comms', message: 'comms', messages: 'comms', reply: 'comms',
  email: 'comms', notification: 'comms', wording: 'comms', phrasing: 'comms',
};

// Substring matching, not token equality: the domain word is nearly always
// inside a longer technical term ("serialized", "concurrent", "deployment"),
// and requiring a whole token would miss most of them. Bounded to words of 4+
// characters so a short token cannot match inside an unrelated one.
function inferDomainsFromText(text) {
  const slug = patternSlug(text);
  if (!slug) return [];
  const found = new Set();
  for (const hint of Object.keys(DOMAIN_HINTS)) {
    if (hint.length < 4) continue;
    // Whole-slug-token boundaries, in slug form where every word is delimited.
    if (new RegExp(`(^|-)${hint}($|-)`).test(slug)) found.add(DOMAIN_HINTS[hint]);
  }
  return [...found];
}

// The declared domains plus whatever the text supports, which is what the
// index stores. Declared domains always win — inference only ADDS, so a model
// that knows its domain is never overridden by a keyword guess.
export function effectiveDomains(text, declared) {
  const out = new Set(Array.isArray(declared) ? declared.filter(Boolean) : []);
  for (const d of inferDomainsFromText(text)) out.add(d);
  return [...out];
}

export function patternId(name) {
  const slug = patternSlug(name);
  if (!slug) return 'unnamed-pattern';
  if (slug.length <= MAX_PATTERN_ID) return slug;
  const digest = createHash('sha256').update(slug).digest('hex').slice(0, PATTERN_ID_DIGEST_CHARS);
  const head = slug.slice(0, MAX_PATTERN_ID - digest.length - 1).replace(/-+$/, '');
  return `${head}-${digest}`;
}

// The id scheme that shipped before this fix. RETAINED, never used to mint a
// new id — only to RECOGNISE one already on disk.
//
// Existing indexes are NOT migrated. Rewriting the keys of a live index would
// silently split one pattern's evidence across two entries, or fuse two
// entries' evidence into one, and both are worse than the truncation they
// replace. Instead every lookup falls back to the legacy id, so an entry
// written by the old scheme stays findable, keeps accumulating evidence on
// promote, and keeps the exact key it was stored under. New promotions of the
// same pattern find that entry through this fallback rather than forking a
// second one — which is the whole obligation; an orphaned key would double-count
// evidence on the next pass.
export function legacyPatternId(name) {
  return patternSlug(name).slice(0, MAX_PATTERN_ID) || 'unnamed-pattern';
}

// THE COMPATIBILITY LOOKUP. Every place that resolves a name to a stored
// entry must ask this rather than indexing with patternId() directly, or a
// pre-fix index silently starts a second entry for the same pattern.
export function findStoredPatternEntry(name, index) {
  const patterns = index?.patterns;
  if (!patterns) return null;
  const id = patternId(name);
  if (Object.hasOwn(patterns, id)) return id;
  const legacy = legacyPatternId(name);
  if (legacy !== id && Object.hasOwn(patterns, legacy)) return legacy;
  return null;
}

// ── Near-duplicate pattern lookup (fragmentation guard) ─────────────────────
// patternId() is a pure slug, so the same pattern worded two ways produces two
// index entries and splits its evidence below the promotion threshold — in the live
// index, "copy-on-write-atomic-rename" and "copy-on-write-with-atomic-rename" were
// both stuck at 1 evidence and could never reach the 3-session bar.
//
// Matching uses token CONTAINMENT, not a string prefix: the real-world drift inserts
// or drops a word mid-name, which a prefix test misses entirely. Containment >= 0.9
// merges near-identical names while still refusing a differing leading word
// ("parallel-then-write" vs "serialize-then-write" scores 0.8 and stays separate).

const NEAR_DUP_CONTAINMENT = 0.9;
const NEAR_DUP_MIN_TOKENS = 3;
const NEAR_DUP_MIN_SHARED = 3;
function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

export function findNearDuplicatePatternId(name, index) {
  const nt = nameTokens(name);
  if (nt.length < NEAR_DUP_MIN_TOKENS) return null;
  const nSet = new Set(nt);
  for (const [id, p] of Object.entries(index?.patterns || {})) {
    const et = nameTokens(p?.name);
    if (et.length < NEAR_DUP_MIN_TOKENS) continue;
    const eSet = new Set(et);
    const shared = et.filter(t => nSet.has(t)).length;
    if (shared < NEAR_DUP_MIN_SHARED) continue;
    // compare against the shorter name so an added qualifier still scores 1.0
    const [shorter, longer] = et.length <= nt.length ? [et, nt] : [nt, et];
    const sSet = new Set(shorter);
    const contained = longer.filter(t => sSet.has(t)).length / shorter.length;
    if (contained >= NEAR_DUP_CONTAINMENT) return id;
  }
  return null;
}

// ── Consolidation of already-fragmented entries ────────────────────────────
// findNearDuplicatePatternId only guards NEW patterns. Entries fragmented before
// the guard existed stay split forever, and because evidence is per-entry, a pair of
// half-strength patterns can never accumulate enough to promote. This walks the
// existing index and folds each near-duplicate into the stronger entry.
//
// The lookups below are plain `index.patterns[id]` with no Object.hasOwn, unlike
// promoteSession and demotePattern. That is deliberate, not an oversight: every
// `id` here is a key this loop got from Object.entries() a few lines above, i.e.
// an own enumerable key — never model-supplied text — and after line ~325
// `processed` guards any id whose entry was already deleted in this pass. A
// prototype key like 'toString' CAN arrive here, as an absorbed id, and is
// deleted correctly.
//
// Verified rather than assumed, because a bare lookup on a deleted key falls
// through to Object.prototype — the obvious latent hazard. Exercised with a
// prototype-named entry that actually gets absorbed: containment must reach the
// 0.9 threshold for the delete to run at all. Covered by the "consolidation
// with a prototype-named entry" case in test-prototype-safety.mjs.
//
// Nothing is destroyed silently: the absorbed entry is copied into
// meta.absorbedPatterns (full record) before removal, so the merge is auditable
// and reversible. Kept = higher evidenceCount, then longer history, then id order.

export function consolidateNearDuplicates(index) {
  const merges = [];
  const entries = Object.entries(index?.patterns || {});
  const processed = new Set();
  for (const [id, p] of entries) {
    if (processed.has(id) || !index.patterns[id]) continue;
    let keepId = id;
    let keep = p;
    for (const [otherId, other] of entries) {
      if (otherId === keepId || processed.has(otherId) || !index.patterns[otherId]) continue;
      if (findNearDuplicatePatternId(other.name, { patterns: { [keepId]: keep } }) !== keepId) continue;
      // same logical pattern — pick the stronger entry to survive
      const keepWins = (keep.evidenceCount || 0) > (other.evidenceCount || 0)
        || ((keep.evidenceCount || 0) === (other.evidenceCount || 0) && (keep.sessions?.length || 0) >= (other.sessions?.length || 0));
      const absorbedId = keepWins ? otherId : keepId;
      const absorbed = index.patterns[absorbedId];
      const survivorId = keepWins ? keepId : otherId;
      const survivor = index.patterns[survivorId];
      survivor.sessions = [...new Set([...(survivor.sessions || []), ...(absorbed.sessions || [])])];
      survivor.domains = [...new Set([...(survivor.domains || []), ...(absorbed.domains || [])])];
      survivor.evidenceCount = Math.max(survivor.evidenceCount || 0, absorbed.evidenceCount || 0, survivor.sessions.length);
      survivor.correspondences = [...new Set([...(survivor.correspondences || []), ...(absorbed.correspondences || [])])];
      survivor.contradictions = [...new Set([...(survivor.contradictions || []), ...(absorbed.contradictions || [])])];
      survivor.nameVariations = [...new Set([...(survivor.nameVariations || []), absorbed.name, absorbedId])];
      // implicatedBy is deliberately NOT merged here. Consolidation runs before
      // the implicature pass, and that pass is a whole-index sweep, so the
      // surviving entry is re-evaluated under its own name on the same promote.
      // Merging the field would be unreachable state: verified by mutation —
      // deleting the merge leaves every assertion green, because no reachable
      // path can observe the difference.
      if (other.status === 'established' && survivor.status !== 'established') survivor.status = 'established';
      for (const f of ['firstSeen', 'lastSeen']) {
        if (absorbed[f] && (!survivor[f] || (f === 'firstSeen' ? absorbed[f] < survivor[f] : absorbed[f] > survivor[f]))) survivor[f] = absorbed[f];
      }
      index.meta.absorbedPatterns = index.meta.absorbedPatterns || [];
      index.meta.absorbedPatterns.push({ absorbed: absorbedId, kept: survivorId, at: new Date().toISOString(), record: absorbed });
      delete index.patterns[absorbedId];
      processed.add(absorbedId);
      merges.push({ kept: survivorId, absorbed: absorbedId });
      if (survivorId !== keepId) { keepId = survivorId; keep = survivor; }
    }
    processed.add(id);
  }
  return merges;
}

// ── Demotion ───────────────────────────────────────────────────────────────
// Without this, a pattern promoted to 'established' is permanent: later evidence
// that contradicts it is recorded but never changes its status. Demotion keeps the
// accumulated evidence while dropping trust back to 'candidate', and records the
// prior status so the change is auditable.

export function demotePattern(index, id, reason = 'contradicted') {
  // Object.hasOwn, not truthiness — see the same guard in promoteSession. The
  // consequence here is worse than a throw: `index.patterns['constructor']`
  // returns the SHARED Object constructor, so the writes below landed on
  // Object.prototype itself and were visible to every object in the process.
  // Measured on the old code, before the throw at the `contradictions` line:
  //   Object.prototype.constructor.status === 'candidate'
  //   own keys added to Object.prototype.constructor: demotedFrom, status,
  //                                                demotedAt, demotedReason
  // and the same via restorePattern(index, 'toString') on Object.prototype.toString.
  // So a single pattern id in a persisted index was enough to poison the whole
  // runtime — including for code that never touches memory.
  const p = Object.hasOwn(index?.patterns ?? {}, id) ? index.patterns[id] : undefined;
  if (!p || p.status === 'candidate') return false;
  p.demotedFrom = p.status;
  p.status = 'candidate';
  p.demotedAt = new Date().toISOString();
  p.demotedReason = reason;
  const note = `demoted from ${p.demotedFrom}: ${reason}`;
  if (!Array.isArray(p.contradictions)) p.contradictions = [];
  if (!p.contradictions.includes(note)) p.contradictions.push(note);
  index.meta.demotions = (index.meta.demotions || 0) + 1;
  return true;
}

// The mirror of demotePattern. It exists because a status the engine can only
// move in one direction trains an operator to distrust the next one — and
// because the status pass needs somewhere to record a promotion that is not
// simply "it crossed a threshold this time".
//
// A first-time crossing of the evidence threshold is NOT a restoration. The
// pattern was never demoted, so calling it a restoration inflated
// meta.restorations and wrote a note claiming it had been frozen, which is
// false history in an audit trail. Only a pattern with a demotion on record
// counts, and only those get the restore wording; a clean first crossing gets
// an "established" note. Smith needs the chip to name the last transition and
// its trigger, so the distinction has to live in the data, not in a reader's
// inference.
//
// Either way the same three provenance fields demotePattern writes are kept
// (from / at / reason), plus restoredFrom. The contradiction NOTE is not
// removed: the record that a freeze happened stays in p.contradictions
// permanently, and only the trust position moves. Evidence accumulates;
// nothing is deleted.
export function restorePattern(index, id, reason = 're-evidenced') {
  // Own-property check for the same reason as demotePattern — this one wrote
  // restoredFrom/status/restoredAt/restoredReason onto Object.prototype.toString.
  const p = Object.hasOwn(index?.patterns ?? {}, id) ? index.patterns[id] : undefined;
  if (!p || p.status === 'established') return false;
  const wasDemoted = typeof p.demotedAt === 'string';
  p.restoredFrom = p.status;
  p.status = 'established';
  p.restoredAt = new Date().toISOString();
  p.restoredReason = reason;
  const note = wasDemoted
    ? `restored to established: ${reason}`
    : `established: ${reason}`;
  // Defensive on `contradictions`: this runs against entries loaded from disk,
  // and a real pre-existing index is not guaranteed to have the field. A
  // hand-written or older entry without it crashed here with
  // "Cannot read properties of undefined (reading 'includes')" — found by
  // loading a legacy-shaped index, not by any test. Demoting or restoring a
  // pattern is a deliberate operator action; neither should be what throws.
  if (!Array.isArray(p.contradictions)) p.contradictions = [];
  if (!p.contradictions.includes(note)) p.contradictions.push(note);
  if (wasDemoted) index.meta.restorations = (index.meta.restorations || 0) + 1;
  return true;
}

// ── Patterns index ─────────────────────────────────────────────────────────


export function loadPatternsIndex() {
  // readStore returns ABSENT for absent/corrupt PLAINTEXT (unchanged behaviour,
  // logged on stderr) and THROWS for a sealed file it cannot open. The catch
  // re-throws DecryptionError rather than converting it into the fresh empty
  // index below — see the block comment on readStore for why that conversion is
  // unrecoverable data loss rather than a degraded feature.
  //
  // Initialised to ABSENT, NOT left undefined, and that initial value is
  // load-bearing. readStore's own try covers only the file read, so a
  // JSON.parse failure on a corrupt PLAINTEXT index propagates out of it and is
  // caught HERE — which means this catch can fire with `loaded` never assigned.
  // Left as `let loaded;` that leaves loaded === undefined, `loaded === ABSENT`
  // is false, and the function returns undefined instead of a fresh index; the
  // next caller dereferences .patterns on undefined and throws a TypeError that
  // names nothing useful. This exact bug shipped in the first draft of this
  // change and was caught by the corrupt-plaintext assertion in the suite.
  let loaded = ABSENT;
  try {
    loaded = readStore(INDEX_FILE, 'patterns index');
  } catch (e) {
    if (e instanceof DecryptionError) throw e;
    console.error('patterns index unreadable, starting fresh:', e.message);
  }
  return loaded === ABSENT ? { version: 1, patterns: {}, meta: { decompositionStats: {}, promotions: 0 } } : loaded;
}

// ── Concurrent-merge for savePatternsIndex ─────────────────────────────────
//
// WHY A MERGE AND NOT JUST THE LOCK. The claim in withIndexLock serialises
// writers, which is necessary but NOT sufficient, and this is the part that is
// easy to get wrong. savePatternsIndex takes a WHOLE SNAPSHOT that the caller
// mutated in memory, possibly long after it was loaded. Serialising the write
// does not help if the payload is already stale:
//
//   A: load()            → {p1}          B: load() → {p1}
//   A: add p2, save()    → writes {p1,p2} B: add p3, save() → writes {p1,p3}
//
// Even with perfect mutual exclusion, B's snapshot never contained p2, so B
// deletes p2 — and the lock did nothing. Under the claim, B must MERGE against
// what is actually on disk rather than publish its stale copy. The lock stops
// two writers from interleaving; the merge stops the second writer from
// resurrecting an outdated view.
//
// THE MERGE RULES, and why each one is the conservative choice:
//
//   id in both      → field-wise merge; the caller's snapshot wins on derived
//                     scalars (status, lastSeen) because it recomputed them,
//                     but set-like fields UNION and counters take MAX. Both
//                     halves are lossless: no recorded session, domain,
//                     correspondence or contradiction is dropped, and evidence
//                     never goes backwards.
//   id only on disk → KEEP IT. This is the actual bug this fixes. A pattern the
//                     caller never saw was added by another process after the
//                     caller loaded; discarding it is the lost update.
//   id only in mine → my addition. Nothing can conflict with it.
//
// THE ONE EXCEPTION TO "KEEP EVERYTHING ON DISK". dedupeNearDuplicates deletes
// entries, and a naive keep-everything merge would resurrect every pattern that
// was ever consolidated — a real regression that re-fights the dedupe logic on
// the next pass. Fortunately that delete is not silent: it tombstones the id in
// meta.absorbedPatterns. So a deletion is honoured exactly when the caller
// holds a tombstone for it, and preservation applies to everything else. This is
// why the tombstone is load-bearing and must not be pruned.
//
// HONEST LIMITATION — the counters are max(), not sum. Two processes promoting
// on the same day each increment meta.promotions from 5 to 6; merging by max
// keeps 6, so a concurrent pair undercounts by one. Summing would need the base
// each writer started from, which means tracking load state on the index object
// and would break the moment a caller hands us a hand-built index. Counters
// here are observability, not data, and max() is chosen because it can never
// over-report. Per-pattern evidence IS data and is unioned exactly.

// Set-like: losing an element loses a fact.
const UNION_FIELDS = ['sessions', 'domains', 'correspondences', 'contradictions'];
// Monotonic: only ever increases, so max() is exact for a single writer and
// undercounts by one under a concurrent pair.
const COUNTER_FIELDS = ['evidenceCount'];

function mergePatternEntry(mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;
  // Caller wins on plain scalars: it recomputed status/lastSeen/name from a
  // newer view than whatever `theirs` was holding.
  const out = { ...theirs, ...mine };
  for (const f of UNION_FIELDS) {
    const a = Array.isArray(mine[f]) ? mine[f] : [];
    const b = Array.isArray(theirs[f]) ? theirs[f] : [];
    out[f] = [...new Set([...b, ...a])];
  }
  for (const f of COUNTER_FIELDS) out[f] = Math.max(mine[f] || 0, theirs[f] || 0);
  // firstSeen is the earliest sighting, so it is the one timestamp where the
  // OLDER value wins. lastSeen keeps the caller's newer value from the spread.
  if (mine.firstSeen && theirs.firstSeen && theirs.firstSeen < mine.firstSeen) {
    out.firstSeen = theirs.firstSeen;
  }
  return out;
}

// Merge numeric leaves by max, used for the nested stat bags. Non-numeric values
// keep the caller's.
function mergeStatBags(mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;
  const out = { ...theirs, ...mine };
  for (const [k, v] of Object.entries(mine)) {
    const t = theirs[k];
    if (typeof v === 'number' && typeof t === 'number') out[k] = Math.max(v, t);
  }
  return out;
}

// `mine` is the caller's (possibly stale) snapshot; `theirs` is what is actually
// on disk. Both are plain parsed index objects; either may be null.
//
// This MERGES and therefore CANNOT express a deletion of a whole meta key.
// `delete index.meta.quarantine` leaves no trace in the caller's snapshot, which
// the merge is required to read as "never saw it, keep the disk's". Measured
// consequence of getting this wrong: clearing the quarantine appeared to work,
// the merge resurrected it from disk, and every subsequent promotion was refused
// as QUARANTINED — a permanently stuck gate. A key deleted by the operator must
// not be silently un-deleted.
//
// Deletion is therefore EXPLICIT, via a tombstone, exactly as it is for patterns
// via meta.absorbedPatterns. Callers that remove a meta key must record it in
// meta.removedKeys so the merge can tell "deleted" from "never seen".
const META_REMOVED_KEYS = 'removedKeys';

export function mergeConcurrentIndex(mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;
  const myPatterns = mine.patterns || {};
  const theirPatterns = theirs.patterns || {};
  const patterns = {};

  for (const id of Object.keys(myPatterns)) {
    if (Object.hasOwn(theirPatterns, id)) patterns[id] = mergePatternEntry(myPatterns[id], theirPatterns[id]);
  }

  // A tombstone is the ONLY evidence of a deliberate delete. Honour it; preserve
  // everything else, because "not in my snapshot" means "I never saw it", which
  // is a statement about my read, not about the file.
  //
  // THE UNION, NOT JUST MINE. This previously read only `mine.meta`'s
  // tombstones, and then unconditionally re-added anything the caller held that
  // disk did not have. Measured consequence: writer 1 absorbed B into A and
  // recorded the tombstone; writer 2 held a STALE snapshot still containing B.
  // The merge returned an index containing B — while meta.absorbedPatterns also
  // still claimed B was absorbed. A pattern that is simultaneously deleted and
  // live, and the tombstone is the record that would have explained it.
  //
  // Both writers' tombstones are therefore unioned, and the same set gates the
  // re-add below. Direction matters: the absorb is the newer, deliberate fact,
  // and a stale reader must not be able to undo it.
  const deletedAnywhere = new Set();
  for (const src of [mine.meta, theirs.meta]) {
    for (const t of src?.absorbedPatterns || []) {
      if (t && typeof t.absorbed === 'string') deletedAnywhere.add(t.absorbed);
    }
  }
  const deletedByMe = new Set();
  for (const t of mine.meta?.absorbedPatterns || []) {
    if (t && typeof t.absorbed === 'string') deletedByMe.add(t.absorbed);
  }
  for (const id of Object.keys(theirPatterns)) {
    if (Object.hasOwn(myPatterns, id)) continue;
    if (deletedByMe.has(id)) continue;
    patterns[id] = theirPatterns[id];
  }
  for (const id of Object.keys(myPatterns)) {
    if (!Object.hasOwn(theirPatterns, id)) patterns[id] = myPatterns[id];
    // The resurrection guard. This is the branch that re-adds what the caller's
    // stale snapshot holds, so it is the one that needs it — without it a
    // deleted pattern returns on the next concurrent save, which is how the
    // pre-fix measurement produced an "absorbed AND live" index.
    if (deletedAnywhere.has(id)) delete patterns[id];
  }
  // The third case, which neither loop above can see: a pattern BOTH sides hold,
  // where one side has since absorbed it. The first loop merged the two entries
  // and kept the result, so the tombstone has to be applied here too — otherwise
  // the merge returns an entry that meta.absorbedPatterns says is gone, which is
  // the "simultaneously absorbed AND live" state the review named.
  //
  // Unconditional, because a tombstone from EITHER writer is a deliberate
  // delete and the surviving entry is precisely the one under dispute.
  for (const id of Object.keys(patterns)) {
    if (deletedAnywhere.has(id)) delete patterns[id];
  }

  const myMeta = mine.meta || {};
  const theirMeta = theirs.meta || {};
  // Honour explicit deletions before anything else. `removedKeys` is the ONLY
  // way a caller can say "I deleted this key", because absence is ambiguous.
  const removedByMe = new Set();
  for (const k of myMeta[META_REMOVED_KEYS] || []) {
    if (typeof k === 'string') removedByMe.add(k);
  }
  const meta = { ...theirMeta, ...myMeta };
  for (const k of removedByMe) delete meta[k];
  // Union the tombstones by absorbed id so neither writer's delete record is
  // lost — these are the proof that a deletion was deliberate.
  const seenTomb = new Set();
  const tombs = [];
  for (const t of [...(myMeta.absorbedPatterns || []), ...(theirMeta.absorbedPatterns || [])]) {
    if (!t || typeof t.absorbed !== 'string') continue;
    if (seenTomb.has(t.absorbed)) continue;
    seenTomb.add(t.absorbed);
    tombs.push(t);
  }
  if (tombs.length) meta.absorbedPatterns = tombs;
  for (const f of ['decompositionStats', 'contradictionStats']) {
    if (myMeta[f] || theirMeta[f]) meta[f] = mergeStatBags(myMeta[f], theirMeta[f]);
  }
  for (const f of ['promotions', 'absorbedCount', 'restorations']) {
    if (typeof myMeta[f] === 'number' && typeof theirMeta[f] === 'number') {
      meta[f] = Math.max(myMeta[f], theirMeta[f]);
    }
  }

  return { ...theirs, ...mine, patterns, meta };
}

// Record a meta key as deliberately removed so the concurrent merge can honour
// the deletion instead of restoring the key from disk. Returns the same index
// for chaining. See META_REMOVED_KEYS for why this cannot be inferred.
export function removeMetaKey(index, key) {
  if (!index || typeof index.meta !== 'object' || index.meta === null) return index;
  delete index.meta[key];
  const list = Array.isArray(index.meta[META_REMOVED_KEYS]) ? index.meta[META_REMOVED_KEYS] : [];
  if (!list.includes(key)) list.push(key);
  index.meta[META_REMOVED_KEYS] = list;
  return index;
}

// This is called on the decomposed-response path, so it must not throw. Measured
// 2026-09-27: the throw is currently caught twice over — queuedWrite's promise
// `.catch` logs it as `[writeQueue]` and writeMemoryLog's own catch returns
// {ok:false} — so the response is NOT a 500, contrary to how the hazard was
// described. The real failure is quieter than a 500 and worse for debugging: the
// index silently stops persisting, every write after it is skipped, and the only
// trace is one line attributed to the write queue, naming neither the index nor
// the cause. A memory index that cannot be saved must degrade the feature — and
// say so — not the response.
//
// Warn once. A read-only or full disk would otherwise emit this on every single
// decomposed response, which is how a log gets ignored.
let indexSaveWarned = false;
// Same policy for the sessions dir (saveWorkingMemory), for the same reason and
// on the same per-response path: one line per failed write would bury it.
let workingSaveWarned = false;

export function savePatternsIndex(index) {
  try {
    mkdirSync(dirname(INDEX_FILE), { recursive: true });
    // Unique tmp name + rename: no torn index on crash, and no writer can
    // truncate another writer's in-flight payload. See writeFileAtomic.
    //
    // Under the claim, we do NOT publish `index` as-is. `index` is whatever the
    // caller was holding when it decided to save, which may predate writes it
    // never saw; writing it verbatim would discard them even with perfect
    // mutual exclusion. So the snapshot is merged against the on-disk state
    // inside the critical section. See mergeConcurrentIndex for the rules.
    //
    // The merge composes with encryption rather than competing with it: the
    // mutator decodes the on-disk store (sealed or not) and hands the merged
    // value back to encodeStore, so the bytes published here are sealed exactly
    // as writeStoreAtomic would have sealed them. Writing the merged JSON
    // directly would be a plaintext leak that no test of the merge would catch.
    withIndexLock(INDEX_FILE, (onDisk) => {
      const merged = mergeConcurrentIndex(index, onDisk);
      return encodeStore(INDEX_FILE, merged);
    }, { label: 'patterns index' });
    return true;
  } catch (e) {
    // Contention is a distinct, retryable outcome and deserves its own line:
    // folding it into the generic warn-once path would report a full disk for
    // what is really "another process held the write claim".
    if (e instanceof ContentionError) {
      console.error(
        `[memory] patterns index NOT saved (write contention) → ${INDEX_FILE}: ${e.message}`);
      return false;
    }
    if (!indexSaveWarned) {
      indexSaveWarned = true;
      console.error(
        `[memory] patterns index NOT saved → ${INDEX_FILE}: ${e.message}\n` +
        '[memory] the memory feature continues without persistence. This is logged ' +
        'once; set OMEGA_MEMORY_INDEX to a writable path outside the checkout.');
    }
    return false;
  }
}

// ── Decomposition parser ───────────────────────────────────────────────────
// Contract: agent ends its response with a ```memory fenced block.
// Pre-fence text is the user-facing display; the fenced body is machine-parsed.
// Parse failures degrade to { memory: null } — never throw, never block the write path.

// A null-prototype map, because the key is attacker-influenced text.
//
// SECTION_MAP is indexed with a section header taken from LLM output, and
// `SECTION_MAP['constructor']` on a normal object literal returns
// Object.prototype.constructor — truthy, so the `|| null` fallback never fired
// and `current` became a FUNCTION. The next line then did
// `memory[current].length` on a key no such section has. Reproduced:
//
//   parseMemoryBlock('```memory\n### constructor\n- x\n```')
//     -> TypeError: Cannot read properties of undefined (reading 'length')
//
// which breaks the contract written above it at :357 — "Parse failures degrade
// to { memory: null } — never throw, never block the write path" — on the
// per-response entry point. No malicious actor is required; a model only has to
// emit the word, and a section header is exactly the kind of thing a model
// emits when it is asked to describe its own memory system.
//
// `__proto__` is the same defect through a different key and is ALSO a live
// trigger here, unlike in promoteSession: the header regex is /^###\s+(\w+)/,
// so `### __proto__` matches, and `SECTION_MAP['__proto__']` returns
// Object.prototype — also truthy, also not a section. Isolated per-process
// sweep of the whole Object.prototype surface, both headers throw; nothing else
// on the surface does. Object.create(null) removes the inherited keys rather
// than filtering a known-bad list, so a future Object.prototype addition
// cannot reopen this.
const SECTION_MAP = Object.assign(Object.create(null), {
  claims: 'claims', patterns: 'patterns',
  correspondences: 'correspondences', contradictions: 'contradictions',
});
const MAX_LINES_PER_SECTION = 20;

export function parseMemoryBlock(raw) {
  const text = String(raw || '');
  const fenceAt = text.indexOf('```memory');
  if (fenceAt === -1) return { display: text.trim(), memory: null };
  const display = text.slice(0, fenceAt).trim();
  const bodyMatch = text.slice(fenceAt).match(/```memory\s*\n([\s\S]*?)(?:```|$)/);
  const memory = { claims: [], patterns: [], correspondences: [], contradictions: [] };
  if (bodyMatch) {
    let current = null;
    for (const line of bodyMatch[1].split('\n')) {
      const header = line.match(/^###\s+(\w+)/);
      if (header) { current = SECTION_MAP[header[1].toLowerCase()] || null; continue; }
      if (!current || !line.trim().startsWith('-')) continue;
      if (memory[current].length >= MAX_LINES_PER_SECTION) continue;
      let item = line.trim().slice(1).trim();
      if (!item || item.length > 300) continue;
      let domains = [];
      const dom = item.match(/\s+—\s+domains?:\s*(.+)$/);
      if (dom) {
        item = item.slice(0, dom.index).trim();
        domains = dom[1].split(',').map(normalizeDomain).filter(d => d);
      }
      if (current === 'claims' || current === 'patterns') memory[current].push({ text: item.slice(0, 200), domains });
      else memory[current].push(item.slice(0, 200));
    }
  }
  return { display, memory };
}

// ── Session working memory (date-as-session, file-backed) ──────────────────
//
// THE ONE PLACE dateStr IS TURNED INTO A FILENAME, so this is where it is
// validated. It was interpolated raw into `working-${dateStr}.json`, which made
// this an arbitrary-path primitive in BOTH directions, not just the write the
// finding reported.
//
// The traversal is easy to underestimate because of the `working-` prefix. The
// interpolated name is `working-` + dateStr, so the FIRST `..` is glued to that
// prefix and becomes a literal path segment rather than a parent reference. One
// `..` therefore does nothing at all. Measured resolution, from a sessions dir
// at <tmp>/home/sessions:
//
//   "../TARGET"          -> <tmp>/home/sessions/working-../TARGET.json   (no escape)
//   "../../TARGET"       -> <tmp>/home/sessions/TARGET.json               (still inside)
//   "../../../TARGET"    -> <tmp>/home/TARGET.json                        (ESCAPES)
//   "../../../../TARGET" -> <tmp>/TARGET.json                             (ESCAPES)
//
// So it takes 3+ segments, which is why a casual single-".." test looks safe.
// The finding's own reproduction used 8, which lands at the filesystem root.
//
// Write side, confirmed: saveWorkingMemory with a 4-segment date returned true
// and created the file outside the sessions dir. Read side, NOT in the finding
// and not previously tested anywhere: loadWorkingMemory with a 3-segment date
// returned the CONTENTS of a file outside the sessions dir. A date that arrives
// from a query param or a filename is a read primitive too, and it is the
// cheaper one to abuse — no write permission needed, just a path the process
// can already read.
//
// Throwing, not coercing. A caller that passes garbage has a bug, and silently
// rewriting its date to today would file a real session's memory under the
// wrong day — a corruption that surfaces weeks later as "why is this pattern
// never promoted". Refusing is the only response that tells the truth.
//
// The regex matches the documented contract (a YYYY-MM-DD session key) and
// cannot be satisfied by any string containing a path separator, so it closes
// the traversal structurally rather than by enumerating bad inputs.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateStr(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) {
    throw new Error(
      `invalid session date ${JSON.stringify(String(dateStr))}: expected YYYY-MM-DD ` +
      '(e.g. "2026-09-30"). The date is used as a filename, so anything containing ' +
      'a path separator would write or read outside the sessions directory.');
  }
  return dateStr;
}

export function workingMemoryPath(dateStr) { return join(SESSIONS_DIR, `working-${assertDateStr(dateStr)}.json`); }

export function loadWorkingMemory(dateStr) {
  assertDateStr(dateStr);
  // Same null-vs-throw contract as loadPatternsIndex: a missing or corrupt
  // session file starts fresh, a sealed file with the wrong key does not.
  // Initialised to ABSENT for the same reason as there — a corrupt plaintext
  // session file throws out of readStore's read-only try and lands in this
  // catch, so `loaded` must already hold the sentinel rather than undefined.
  let loaded = ABSENT;
  try {
    loaded = readStore(workingMemoryPath(dateStr), `working memory ${dateStr}`);
  } catch (e) {
    if (e instanceof DecryptionError) throw e;
    console.error(`working memory ${dateStr} unreadable, starting fresh:`, e.message);
  }
  return loaded === ABSENT ? { date: dateStr, entries: [], contradictions: [] } : loaded;
}

// A working memory that cannot be SAVED must degrade the feature, not the caller
// — the rule savePatternsIndex (:332) already follows, and this was the one write
// path in the file that did not: loadWorkingMemory above has a try/catch and that
// one has one, and an unwritable sessions dir threw straight out of the only
// server-reachable entry point (server.mjs:488).
//
// The cost was not the response — queuedWrite absorbs it (:67) and writeMemoryLog
// catches it (:519) — it was the RETURN VALUE. queuedWrite's .catch resolves to
// undefined, so `flags = await queuedWrite(...)` took undefined and :518's
// `contradictions: flags || []` then reported ZERO contradictions for a session
// that had them. Returning false keeps the flags intact at the call site, because
// they are computed before this call and are still true.
// ...and this function follows it for I/O failures only. An unwritable sessions
// dir returns false and logs once, because the memory feature genuinely can
// continue without session persistence.
//
// A MALFORMED DATE IS NOT IN THAT CATEGORY, and folding the two together is
// itself a bug. A bad date is a caller bug, not an environment problem: no
// retry fixes it, no permission change fixes it, and the write is refused for
// a reason that has nothing to do with the disk. Returning false here would
// report a traversal attempt as "[memory] the memory feature continues without
// session persistence — set OMEGA_MEMORY_SESSIONS_DIR to a writable path",
// sending the operator to chmod a directory that was never the problem. That is
// the looks-fine-while-broken failure this file already warns about, in the
// exact place a wrong answer costs the most: an invalid date is refused
// loudly, every I/O failure still degrades quietly.
export function saveWorkingMemory(dateStr, working) {
  // Deliberately OUTSIDE the try: a caller bug must not be laundered into a
  // disk warning. See above.
  const p = workingMemoryPath(dateStr);
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // Same reasoning as savePatternsIndex — see writeFileAtomic. And the same
    // seal step: the session file is where a claim's verbatim text first lands,
    // so sealing only the index would leave every promoted pattern readable in
    // the clear one directory over.
    writeStoreAtomic(p, working);
    return true;
  } catch (e) {
    // Logged once, not per write: this is a per-response path and a session can
    // produce many, and a line per response buries the one line that matters.
    if (!workingSaveWarned) {
      workingSaveWarned = true;
      console.error(
        `[memory] working memory NOT saved → ${SESSIONS_DIR}: ${e.message}\n` +
        '[memory] the memory feature continues without session persistence. ' +
        'This is logged once; set OMEGA_MEMORY_SESSIONS_DIR to a writable path.');
    }
    return false;
  }
}

// ── Claim quality gate ───────────────────────────────────────────────────────
//
// Runs BEFORE a claim is allowed to become evidence for a pattern. This is
// upstream of every heuristic we were going to tune, and it exists because the
// corpus turned out to be an LLM writing a diary about its own output quality
// during a 180-task greeting benchmark.
//
// DESIGN CONSTRAINT — this gate is deliberately NEGATIVE-ONLY. It rejects
// claims that are provably not durable knowledge. It does NOT attempt to judge
// whether a claim is good, true, or worth keeping. We are calibrating against a
// corpus that contains no real contradictions, so any positive judgement here
// would be exactly the kind of threshold fitted to noise that we refused for
// Q1 and Q2. A narrow filter with a known false-positive rate beats a broad
// scorer with an unknown one.
const REJECT = {
  // The agent grading or describing its own output. This is the dominant
  // failure: it looks like a pattern, recurs every session, and teaches nothing
  // about how Josh works.
  selfOutputQuality: /\b(miscount|miscounted|miscounting|violat(?:ed|es|ion)\b.*\b(word|length|constraint)|(?:word|length)[- ]constraint|word[- ]count|responded with \d+ words?|should have (?:been|said)|instead of \d+ words?)/i,
  // An LLM narrating the memory system itself, in the third person.
  memorySystemMeta: /\b(no relevant patterns|patterns? (?:found|matched) for the task|task mismatch|reviewer pass|verdict on non-code|memory (?:block|system) (?:returned|produced)|decomposition (?:stats|quality))/i,
  // An event log, not a durable fact. "X completed the 5-word task" describes
  // one dispatch; it is not knowledge that will still be true next week.
  eventLog: /\b(task (?:was|has been) (?:completed|assigned|dispatched)|was completed by|completed the \d+-word|no specific task|new session with a simple greeting|user (?:greeted|initiated|initiated contact|sent a greeting))/i,
  // A request log. "The user requested a 5-word greeting" records one ask; it
  // is not a preference and will be false as soon as Josh asks for something
  // else. Kept separate from eventLog because the phrasing differs, but both
  // are the same failure: a moment mistaken for a trait.
  requestLog: /\b(the )?user (?:requested|asked for|asked|wants?|needs? to)\b|\buser (?:then )?(?:requested|asked for)\b/i,
  // Infrastructure narration. "Connection is live", "provider has no API key"
  // is a momentary status report from the agent about its own plumbing. It
  // expires the moment the condition changes, so promoting it is a trap.
  infraStatus: /\b(connection is (?:live|operational)|is (?:live and )?operational|api key (?:is )?(?:not )?configured|provider .* (?:unavailable|unreachable|failing|down)|endpoint (?:unreachable|down)|no api key)\b/i,
  // A one-off constraint attached to a single task. "Exceeded 5-word limit"
  // describes one response; it is self-evaluation wearing a measurement.
  transientConstraint: /\b(exceeded|within|met|violated)\s+(?:the\s+)?\d+[- ]word\b|\b\d+[- ]word (?:limit|constraint|response|reply|answer|greeting|task)\b/i,
};

// ── THE 2026-09-25 EXTENSION ────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS. The six families above were written against a
// greeting benchmark and they worked: meta.qualityGate on the live index reads
// 762 accepted / 110 rejected. But two facts measured afterwards say they were
// not enough, and neither was visible from the fixtures that produced them.
//
// FACT 1 — THE GATE WAS NEVER CALLED BY THE LIBRARY. assessClaim had zero
// callers inside polymem.mjs: it was exported for a consumer to remember to
// call. Run those six families over the 24 patterns the quarantine actually
// held and 16 are ACCEPTED, including "casual-greeting", "standard-greeting",
// "five-word-salutation" and "direct-minimal-response-to-simple-greetings".
// A filter nobody invokes is not a filter. assessClaim is now called on the
// promotion path itself (see promoteSession), and the six families below were
// added to the same table rather than replacing it.
//
// FACT 2 — THE MISSING CLASSES. Every one of the 85 real pattern names that
// produced the quarantine describes THE CONVERSATION rather than Josh's work.
// Measured over that corpus: 0 of 85 name a person, project, file, or system.
// The existing families catch word-counting self-assessment (selfOutputQuality),
// which was 3 of 85. They do not catch the greeting family at all, because
// "Casual greeting" is not an event log, not a request log, and not
// infrastructure — it is simply a subject with nothing behind it.
//
// So the families below reject on SUBJECT rather than on phrasing: a name whose
// entire subject is the exchange (greeting, acknowledgment, the reply itself,
// the dispatch machinery) is not knowledge about Josh's work, however
// confidently it is phrased.
//
// WHAT THIS IS NOT. Still negative-only, still no scoring, still no
// embeddings and no LLM. The four rules are lexical and they are honest about
// their ceiling: run over the real 85 they reject 63. The remaining 22 are
// named in test/test-real-corpus.mjs as a standing false-negative list, so the
// limit is a measured number in the suite rather than a claim in a comment.
// "Code Review" and "Debugging Process" survive, and no lexical rule can be
// relied on to separate those from "Task Reponse" without a judge.
const REJECT_PATTERN_SUBJECT = {
  // The greeting family — 19 of the 85 real names. "Casual greeting",
  // "Five-word salutation", "Friendly greeting", "Command-line greeting".
  greeting: /\b(greet(?:ing|s)?|salutation|hello|\bhi\b|\bhey\b|farewell|well[- ]wish)/i,
  // An acknowledgement is a receipt, not a fact. "Minimalist greeting
  // acknowledgment", "Response Acknowledgment".
  acknowledgment: /\b(acknowledg(?:e|ed|ement|ements)|acknowledgement|welcom(?:e|ing))\b/i,
  // The exchange described in the abstract. "Simple greeting task", "Standard
  // greeting response." — an adjective plus a conversation noun and no subject.
  taskRestatement: /\b(?:simple|basic|standard|short|brief|minimal|generic)\s+(?:\w+\s+){0,2}(?:task|response|command|output|message|answer|reply|prompt|check|pattern|handling)\b/i,
  // "Running the deploy checks now" — status, not knowledge. Anchored on the
  // present-progressive so a PAST-tense statement about a finished check is not
  // caught; that would reject real operational history.
  transientStatus: /\b(?:running|executing|starting|proceeding|continuing)\b[^.]*\b(?:now|checks?|tests?|scan)\b/i,
  // A preference asserted about "the user" with no other subject is a restated
  // request: the user asked for one thing once, and the agent filed it as a
  // standing preference. Josh's real preferences are recorded against him
  // ("Josh prefers direct action over a plan document") and are unaffected.
  preferenceWithoutSubject: /\bthe user (?:prefers|likes|wants|needs|asked|requested)\b/i,
  // A name that is ONLY the conversation. Anchored ^…$ so it cannot fire on a
  // pattern that merely mentions a response: "Use own-property checks for any
  // key derived from model output" contains no such anchor, and neither does
  // "Response caching invalidates on schema change".
  selfDirectedOutput: /^(?:[\w\s,'-]{0,40}\b)?(?:responses?|outputs?|replies|communication|messages?|acknowledgment|acknowledgement)\.?$/i,
  // "Task processing pattern: The system processes tasks sequentially or
  // concurrently based on configuration" — a restatement of the dispatch loop
  // dressed as an architecture claim.
  conversationSubject: /\b(?:conversation|chat|dialogue|dialog|prompt|task)\s+processing\s+pattern\b/i,
};

// Dispatch machinery as the WHOLE subject. This one is not a phrase list — it
// is a length test, because the signal is that the name has no content beyond
// the machinery: every real pattern it rejects ("Task completion count",
// "Assignments to specialists for specific tasks", "Task Reponse") is 4 content
// tokens or fewer. Substantive knowledge does not fit under the cap, which is
// why MUST_KEEP loses nothing to it (asserted in the suite, not assumed).
const DISPATCH_MACHINERY_TOKENS = /\b(task|tasks|output|outputs|response|responses|reply|replies|count|completion|execution|dispatch|assignment|decomposition|delegation|breakdown)\b/i;
const DISPATCH_MACHINERY_MAX_CONTENT_TOKENS = 4;

// ── Articulate subject: a name that describes an activity instead of asserting
// a fact about the system ────────────────────────────────────────────────────
// Measured over the 85 real names behind the 2026-09-25 quarantine: 74 rejected,
// 11 surviving. These three shapes close 11 of the 22 that survived the families
// above, at zero cost to knowledge.
//
// A broad version of this rule was tried first and REJECTED: "has no finite
// verb" caught only 4 and destroyed "Intra-session contradiction tracking",
// which is knowledge. A rule that trades real knowledge for noise is a bad
// trade however good the headline number looks, so each shape below is
// deliberately narrow — a complete shape, not a missing-word heuristic.
const SUBJECT_ECHO = /^echo\b/i;
// Ends in a nominalization, so the name DESCRIBES an activity rather than
// asserting anything: "Explanation writing", "Requirement verification
// omission". Anchored to the final word, ≤4 words, and vetoed by any predicate.
const SUBJECT_NOMINALIZED_ACTIVITY = /(?:writing|omission|satisfaction|matching|adherence|calculations)$/i;
// "<modifier> <head>" with no article and no predicate, where the head is a
// process artifact: "Code Review", "Debugging Process", "Action Plan".
const SUBJECT_PROCESS_ARTIFACT = /(?:pattern|process|plan|check|review)$/i;
// Any assertion turns a label into a claim. This veto is what lets the
// knowledge-side guards through: "Intra-session contradiction tracking catches
// drift before it becomes a contradiction" keeps its predicate and survives.
const SUBJECT_PREDICATE = /\b(?:is|are|was|were|has|have|cannot|should|must|does|do|fails?|breaks?|loses?|returns?|when|while|before|after|until|because|unless|so|rather|instead|never|always|still)\b/i;
const SUBJECT_MAX_WORDS = 4;

// Returns a reason string when the WHOLE name is an articulate subject.
function classifyArticulateSubject(text) {
  const clean = String(text).replace(/[*_`#]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (SUBJECT_ECHO.test(clean)) return 'echoArtifact';
  const ws = clean.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (ws.length < 2 || ws.length > SUBJECT_MAX_WORDS) return null;
  if (SUBJECT_PREDICATE.test(clean)) return null;
  if (SUBJECT_NOMINALIZED_ACTIVITY.test(ws[ws.length - 1])) return 'nominalizedActivity';
  if (ws.length === 2 && SUBJECT_PROCESS_ARTIFACT.test(ws[1])) return 'bareProcessLabel';
  return null;
}

function contentTokenCount(text) {
  const stop = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'with',
    'and', 'or', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'at', 'by', 'from', 'but',
    'if', 'then', 'than', 'so', 'such', 'very', 'more', 'most', 'less', 'least', 'can', 'could',
    'will', 'would', 'should', 'may', 'might', 'must', 'do', 'does', 'did', 'done', 'have', 'has',
    'had', 'there', 'here', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'any',
    'both', 'each', 'few', 'other', 'some', 'only', 'own', 'same', 'too', 'also', 'just', 'now',
    'not', 'no', 'pattern',
  ]);
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w)).length;
}

// The single place a pattern name is judged. Shared by assessClaim (so a claim
// and a pattern are filtered by one rule, which is what keeps the two from
// drifting) and by the promotion path.
function classifyPatternSubject(text) {
  for (const [reason, re] of Object.entries(REJECT_PATTERN_SUBJECT)) {
    if (re.test(text)) return reason;
  }
  if (
    DISPATCH_MACHINERY_TOKENS.test(text)
    && contentTokenCount(text) <= DISPATCH_MACHINERY_MAX_CONTENT_TOKENS
  ) return 'dispatchMachinery';
  const articulate = classifyArticulateSubject(text);
  if (articulate) return articulate;
  return null;
}

// ONE normalizer, used by the gate and by every caller that has to build the
// `seen` set the gate checks against. These two used to be written out
// separately (assessClaim here, sim/writer.mjs and tools/real-corpus-probe.mjs
// out here), so a drift in the rule would silently make the caller's dedup a
// different rule than the gate's. A duplicate check that disagrees with itself
// is worse than none: it looks like it is working.
function claimKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function assessClaim(claim, seenThisSession = new Set()) {
  const text = (claim && (claim.text || claim)) || '';
  if (typeof text !== 'string' || !text.trim()) return { accept: false, reason: 'empty' };
  const key = claimKey(text);
  if (seenThisSession.has(key)) return { accept: false, reason: 'duplicate-in-session' };
  for (const [reason, re] of Object.entries(REJECT)) {
    if (re.test(text)) return { accept: false, reason };
  }
  const subjectReason = classifyPatternSubject(text);
  if (subjectReason) return { accept: false, reason: subjectReason };
  return { accept: true };
}

// Assess a PATTERN NAME. Separate name because the evidence question differs —
// assessClaim's duplicate-in-session check is about a claim repeating inside one
// session, and applying it to patterns would make a name that legitimately
// recurs across a session's entries look like a duplicate.
// PROVENANCE, CARRIED NOT INFERRED. stampProvenance already does this for
// claims; patterns were the one artifact in the store with no link back to the
// dispatch that produced them, which is precisely why the 24 quarantined
// patterns had to be adjudicated by hand months later.
//
// Every field is read off the session entry that carried the pattern, and an
// absent field stays 'unknown'. That is not laziness — it is the rule
// stampProvenance already follows. 182/182 real entries carry `taskId` but
// 0/182 carry a `model` key (the provider string embeds the model), so
// reporting a model here would be inventing one. Nothing is derived from the
// session date or the agent name for the same reason: derived provenance is
// indistinguishable from real provenance once it is in the file.
function patternSource(entry, session) {
  return {
    session,
    // `time` is the timestamp field real entries actually carry.
    time: entry.time || null,
    task: entry.task || 'unknown',
    taskId: entry.taskId || 'unknown',
    provider: entry.provider || 'unknown',
    model: entry.model || 'unknown',
    agent: entry.agent || 'unknown',
    routeSource: entry.routeSource || 'unknown',
  };
}

export function assessPatternName(name) {
  const text = typeof name === 'string' ? name : ((name && (name.text || name.name)) || '');
  if (!text || !text.trim()) return { accept: false, reason: 'empty' };
  for (const [reason, re] of Object.entries(REJECT)) {
    if (re.test(text)) return { accept: false, reason };
  }
  const subjectReason = classifyPatternSubject(text);
  if (subjectReason) return { accept: false, reason: subjectReason };
  return { accept: true };
}

// ── Provenance ───────────────────────────────────────────────────────────────
//
// A claim used to be an orphan string. There was no way to tell, after the
// fact, whether a claim came from a frontier model doing real work or from a
// weak model reacting to a smoke-test string. That gap is exactly why the
// corpus was unreadable. Every claim now carries the model that produced it
// and the task it came from.
export function stampProvenance(claims, { provider, model, task, taskId, agent, routeSource } = {}) {
  // routeSource records WHICH of provider/model actually served this output and
  // why it was chosen. Without it a claim produced by a hardcoded degraded
  // fallback is indistinguishable from a claim produced by a real routing
  // decision — which is how 18 degraded ollama tasks and 166 longcat
  // fallback-chain tasks came to look like routing evidence.
  const src = routeSource || 'unknown';
  // taskId is what makes a claim auditable months later. "qwen said this" is
  // not evidence; "task-1790260857672-1 said this" points back at a specific
  // dispatch whose prompt and output are both still retrievable.
  //
  // Absent provenance is recorded as 'unknown' and NEVER inferred. Deriving a
  // model from the agent name or the session date would manufacture exactly
  // the false attribution this quarantine exists to correct.
  const tid = taskId || 'unknown';
  // provider/model default to 'unknown' rather than left undefined. undefined is
  // dropped entirely by JSON.stringify, which makes "never recorded" look
  // identical to "not applicable to this claim" — exactly the ambiguity that
  // let the longcat attribution go unchallenged. An explicit 'unknown' states
  // that provenance is absent, without guessing what it was.
  const prov = provider || 'unknown';
  const mdl = model || 'unknown';
  return (claims || []).map(c => {
    if (!c || typeof c !== 'object') return { text: String(c), provider: prov, model: mdl, task, taskId: tid, agent, routeSource: src };
    return { ...c, provider: prov, model: mdl, task, taskId: tid, agent, routeSource: src };
  });
}

// ── Intra-session contradiction cross-check ────────────────────────────────
// Narrow Phase 1 heuristic: subject-token overlap >= 50% + opposite polarity.

const STOPWORDS = new Set('the a an is are was were be been being to of in on for with and or it its this that these those as at by from but if then than so such very more most less least can could will would should may might must do does did done have has had there here what which who when where why how all any both each few other some only own same too also just now not no'.split(' '));
// Polarity signals. Two families: syntactic negations ("not", "cannot") and
// negative-valence adjectives ("useless", "flawed"). The second family matters because
// agent output states disagreement as judgment far more often than as "not" — without
// them, "the approach is useless" read as positive against "the approach is useful".
const NEGATORS = new Set([
  // syntactic
  'not', 'no', 'never', 'cannot', "can't", 'wont', "won't", 'doesnt', "doesn't", 'isnt', "isn't", 'arent', "aren't", 'wasnt', "wasn't", 'without', 'lacks', 'lacking',
  // failure / rejection
  'broken', 'breaks', 'broke', 'fails', 'failed', 'fail', 'failing', 'crash', 'crashes', 'crashed', 'timeout', 'timeouts', 'rejected', 'rejects', 'blocked', 'blocks', 'disabled', 'removed', 'dropped',
  // negative judgment
  'deprecated', 'avoid', 'wrong', 'bad', 'worse', 'worst', 'unusable', 'unsuitable', 'harmful', 'wrongly', 'useless', 'pointless', 'unhelpful', 'defective', 'flawed', 'inadequate', 'insufficient', 'unworkable', 'unreliable', 'unstable', 'unsafe', 'incorrect', 'invalid', 'ineffective', 'redundant', 'wasteful', 'waste', 'weak', 'painful', 'anti', 'against',
]);

function contentTokens(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ── Implicature: is a recorded contradiction ABOUT this pattern? ─────────────
//
// This used to be a substring test:
//
//   contentTokens(claim).some(w => p.name.toLowerCase().includes(w))
//
// Any one shared word implicated a pattern. Measured against the live corpus,
// that demoted `atomic-rename-prevents-a-torn-index-on-crash` because some
// unrelated claim mentioned "index", and on a real session it froze 61 of 71
// patterns. On the quarantined index, 8 of 24 names are implicable by a bare
// 3-letter token ('ate', 'out', 'end', 'fix') appearing anywhere in the name.
//
// The rule now matches the one checkIntraSessionContradictions already uses to
// decide that two CLAIMS disagree: same subject, opposite polarity. Same
// definition in both places, so a claim/claim conflict and a claim/pattern
// conflict cannot drift apart.
//
// Two additions, both needed because a pattern name and a claim are different
// kinds of string:
//   - MIN_SHARED 2. With a 1-token pattern name, min() is 1, so a single shared
//     word scores 1.0 and "Greeting" is implicated by anything about greetings.
//   - polarity is checked on the contradiction's own pair, not name-vs-claim. A
//     pattern name is a noun phrase with no polarity; comparing it to a claim
//     would make every pattern look positive.
const IMPLICATURE_MIN_OVERLAP = 0.5;
const IMPLICATURE_MIN_SHARED = 2;
// No separate minimum-length or minimum-token guard is needed on either side.
// `shared >= IMPLICATURE_MIN_SHARED` is strictly stronger than both: a string
// with fewer than two content tokens can never share two, so it rejects them
// first and short-circuits before the division. Verified by mutation —
// reinstating either check leaves the suite green, because neither can change
// an outcome. A branch that cannot fail is not a guard.
function subjectsOverlap(a, b) {
  const at = contentTokens(a), bt = contentTokens(b);
  const bSet = new Set(bt);
  const shared = at.filter(w => bSet.has(w)).length;
  return shared >= IMPLICATURE_MIN_SHARED && shared / Math.min(at.length, bt.length) >= IMPLICATURE_MIN_OVERLAP;
}

// Detector-generated records carry {newClaim, existingClaim}; agent-authored
// ones in the memory fence are bare strings. Only the former can be tested, and
// a string must not be coerced into a pair of "undefined".
function isContradictionRecord(c) {
  return !!c && typeof c.newClaim === 'string' && typeof c.existingClaim === 'string'
    && c.newClaim.trim() !== '' && c.existingClaim.trim() !== '';
}

export function isImplicatedBy(name, contradiction) {
  if (!isContradictionRecord(contradiction)) return false;
  // A detector false positive — two claims that overlap but share a polarity —
  // must not demote anything.
  //
  // polarityRelativeTo() rather than a bare polarity() comparison, because the
  // NEGATORS set is a JUDGMENT lexicon. That is right for claim-vs-claim
  // ("the approach is useless" vs "the approach is useful") and wrong here: a
  // pattern name is a fix-description whose subject IS the failure, so
  // "Atomic rename prevents a torn index on crash" carries the negator `crash`
  // as topic rather than as judgment. Read bare, it scored 'neg' — identical to
  // "does NOT prevent" — and every contradiction about it was silently dropped,
  // which is the one failure mode a promotion gate must not have. Masking the
  // pattern's own tokens out of the polarity read fixes it: `crash` stops
  // counting, `not` keeps counting, and the pair diverges as it should.
  if (polarityRelativeTo(contradiction.newClaim, name) === polarityRelativeTo(contradiction.existingClaim, name)) return false;
  return subjectsOverlap(name, contradiction.newClaim) || subjectsOverlap(name, contradiction.existingClaim);
}
// Polarity of `claim` as a statement ABOUT `patternName`: negator words that
// merely name the pattern's subject (its own tokens) are not judgments of it.
function polarityRelativeTo(claim, patternName) {
  const own = new Set(contentTokens(patternName));
  const words = String(claim).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/);
  return words.some(w => NEGATORS.has(w) && !own.has(w)) ? 'neg' : 'pos';
}
function polarity(text) {
  // NOTE: tokenize WITHOUT stopword filtering — "not"/"no" are stopwords but are
  // exactly the polarity signals we need here. Filtering first made every claim positive.
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/);
  return words.some(w => NEGATORS.has(w)) ? 'neg' : 'pos';
}

export function checkIntraSessionContradictions(working, newClaims) {
  const existing = [];
  for (const e of working.entries) for (const c of e.claims || []) existing.push(c.text);
  const flags = [];
  for (const claim of newClaims) {
    const ct = contentTokens(claim.text || claim);
    if (ct.length < 2) continue;
    for (const ex of existing) {
      const et = contentTokens(ex);
      if (et.length < 2) continue;
      const shared = ct.filter(w => et.includes(w)).length;
      if (shared / Math.min(ct.length, et.length) >= 0.5 && polarity(claim.text || claim) !== polarity(ex)) {
        flags.push({ newClaim: claim.text || claim, existingClaim: ex, resolution: 'unresolved' });
      }
    }
  }
  return flags;
}

// THE CLAIM GATE, ON THE WRITE PATH.
//
// assessClaim had ZERO callers inside this file, exactly as assessPatternName
// had before promoteSession started calling it. It was a filter the consumer
// had to remember to invoke, and the 2026-09-25 greeting benchmark is what
// that costs: 1083 real claims, of which the gate rejects a large share, all
// written to disk unfiltered.
//
// WHY THAT MATTERS BEYOND A FILTHY FILE. checkIntraSessionContradictions reads
// entry.claims, so an ungated noise claim does not merely sit there — it
// becomes a HALF OF A CONTRADICTION RECORD. The implicature pass at :1855 then
// tests that record against every pattern in the index and freezes the ones it
// implicates, permanently demoting them to candidate. Measured on the real
// corpus: 157 of 474 promoted patterns carry an implicatedBy freeze, and 94 of
// those are implicated ONLY by contradictions built from claims this gate
// rejects. Gating the write path unfreezes 87 and loses zero patterns.
//
// That set is not only noise. `Chief of Staff handles simple direct requests
// without delegation` is on the must-keep list in
// docs/2026-09-25-promotion-defect.md — one of four items that document says
// must never be tightened away. An ungated claim actively DELETED it from the
// established set. The gate is not a tidiness pass; it is what keeps real
// knowledge reachable.
//
// ORDER MATTERS AND IS NOT INTERCHANGEABLE. The gate runs BEFORE
// checkIntraSessionContradictions, so a rejected claim cannot contribute a
// contradiction, and before the entry is pushed, so it cannot be read back as
// existing context by a later call in this same session.
//
// THE `seen` SET IS PER-ENTRY, NOT PER-SESSION, and that is a measured
// decision rather than convenience. Seeding it from every claim already in the
// session drops 45 cross-entry duplicates — and all 45 carry a DIFFERENT
// taskId than the copy it kept. Those are separate dispatches independently
// asserting the same fact, which is corroborating evidence, not duplication.
// Dropping them would delete the audit trail that makes a claim worth
// keeping. A within-entry duplicate really is the same dispatch saying it
// twice, and that is the only duplicate the gate should see.
//
// REJECTIONS ARE RECORDED, NOT DELETED, matching index.meta.patternGate: the
// operator can see what was dropped and why instead of finding a hole.
export function appendWorkingMemory(dateStr, entry) {
  const working = loadWorkingMemory(dateStr);
  const seen = new Set();
  const claims = [];
  // loadWorkingMemory's fresh shape is {date, entries, contradictions} — no
  // `meta` — so this has to CREATE it, not just write into it when it happens
  // to be there. Guarding on `working.meta` would silently discard every
  // rejection count on every fresh session, which is the looks-fine-while-
  // broken shape this file keeps warning about: the gate would appear to record
  // nothing and there would be no way to tell why.
  working.meta = working.meta || {};
  const gateStats = working.meta.claimGate || { accepted: 0, rejected: 0, byReason: {} };
  for (const c of entry.claims || []) {
    const verdict = assessClaim(c, seen);
    if (!verdict.accept) {
      gateStats.rejected++;
      gateStats.byReason[verdict.reason] = (gateStats.byReason[verdict.reason] || 0) + 1;
      continue;
    }
    gateStats.accepted++;
    // FILL-ONLY. stampProvenance assigns every field unconditionally, so
    // calling it here with entry-level fields would OVERWRITE attribution the
    // claim already carries. Measured on the real corpus: 4640 claim fields
    // hold a real value the entry also has, and 0/182 entries carry a `model`
    // key at all (the provider string embeds it) — so an overwrite stamps
    // "unknown" over real model attribution on all 1083 claims. That is the
    // longcat attribution defect, rebuilt one layer down. Only fill a field
    // the claim is missing or already marked unknown.
    const filled = { ...c };
    for (const k of ['provider', 'model', 'task', 'taskId', 'agent', 'routeSource']) {
      if (filled[k] === undefined || filled[k] === null || filled[k] === 'unknown') {
        const from = entry[k];
        if (from !== undefined && from !== null && from !== '') filled[k] = from;
      }
    }
    claims.push(filled);
    seen.add(claimKey(filled.text));
  }
  working.meta.claimGate = gateStats;
  const gatedEntry = { ...entry, claims };
  const flags = checkIntraSessionContradictions(working, claims);
  working.entries.push(gatedEntry);
  for (const f of flags) working.contradictions.push({ ...f, time: entry.time, agent: entry.agent });
  saveWorkingMemory(dateStr, working);
  return flags;
}

// ── Promotion (evidence-gated, manual trigger in Phase 1) ──────────────────
// candidate:  2+ sessions OR 2+ domains
// established: 3+ sessions AND 2+ domains, and not implicated in an unresolved
//              contradiction that no LATER clean session has re-evidenced
//
// IDEMPOTENCE. Status is a pure function of accumulated state — p.sessions,
// p.domains, p.implicatedBy — and never of which session was promoted last or
// in what order. Every write into those three is a set-union keyed by session
// date, so replaying history converges on the same index. It did not before:
// contradictions were re-read from the session file on every promote, so
// re-promoting an old session re-applied its freeze (established -> candidate),
// and each pass stamped a fresh `unresolved contradiction <now>` note so the
// pattern's own audit trail grew on every replay. Measured before this change:
// a forward pass over 09-01..09-05 left the pattern established; replaying 09-04
// afterwards left it candidate. The index depended on replay order.

export class QuarantineError extends Error {
  constructor(count, restoreCommand) {
    super(`corpus is quarantined (${count} patterns held in meta.quarantine); promotion refused. Restore with: ${restoreCommand}`);
    this.name = 'QuarantineError';
    this.code = 'QUARANTINED';
    this.count = count;
    this.restoreCommand = restoreCommand;
  }
}

// Would later evidence have cleared an earlier freeze? A contradiction raised in
// session D freezes a pattern until a session AFTER D re-invokes it. Equality
// means the same session both re-invoked and contradicted — that stays frozen.
function lastEvidenceDate(p) { return (p.sessions || []).slice().sort().pop() || null; }
function lastImplicationDate(p) { return (p.implicatedBy || []).slice().sort().pop() || null; }

export function computeStatus(p) {
  const n = (p.sessions || []).length, m = (p.domains || []).length;
  if (n < 3 || m < 2) return 'candidate';
  const ev = lastEvidenceDate(p), im = lastImplicationDate(p);
  if (im && (!ev || im >= ev)) return 'candidate';
  return 'established';
}

export function promoteSession(dateStr, index) {
  // ── Quarantine gate ──────────────────────────────────────────────────────
  // Runs BEFORE anything mutates. meta.quarantine is the only thing standing
  // between the 24 held patterns and the live index, and nothing in this module
  // read it: one POST /api/memory/promote re-imported the whole corpus the
  // quarantine exists to keep out. quarantine-patterns.mjs guards the SOURCE
  // files, but promoteSession rebuilds from whatever is on disk, and the source
  // guard does not constrain this function.
  //
  // Thrown, not returned: a returned {promoted: []} is indistinguishable from a
  // session that legitimately produced nothing, which is the same
  // looks-fine-while-broken shape this file has been burned by repeatedly.
  const q = index?.meta?.quarantine;
  if (q?.patterns && Object.keys(q.patterns).length) {
    throw new QuarantineError(Object.keys(q.patterns).length, q.restoreCommand || 'node quarantine-patterns.mjs --restore');
  }

  // Heal entries fragmented before the near-dup guard existed, so their evidence
  // can accumulate instead of being split below the promotion threshold.
  const consolidated = consolidateNearDuplicates(index);
  const working = loadWorkingMemory(dateStr);
  const now = new Date().toISOString();
  const sessionPatterns = new Map();
  // THE GATE, ON THE PROMOTION PATH. This is the change that makes the rest of
  // it matter. assessClaim existed since the greeting benchmark and had ZERO
  // callers in this file — it was exported for a consumer to remember to
  // invoke, and the consumer's memory of invoking it is exactly what the
  // 2026-09-25 quarantine measures: 87 patterns promoted from a greeting
  // benchmark, none of them filtered, 24 of them surviving long enough to be
  // quarantined by hand.
  //
  // So the filter is now structural rather than advisory. A consumer that
  // forgets to call assessClaim still gets a filtered index, because the
  // promotion path calls it itself. That is the same reasoning as the repo-root
  // containment check at the top of this file: "remember to set it" is a wish,
  // not a control.
  //
  // The gate is deliberately NOT a hard delete. A rejected name is recorded in
  // index.meta.patternGate with its reason, so the operator can see what was
  // dropped and why — the same auditability the quarantine record itself
  // demanded and could not get.
  const gateStats = (index.meta.patternGate ||= { accepted: 0, rejected: 0, byReason: {} });
  for (const e of working.entries) {
    for (const p of e.patterns || []) {
      const verdict = assessPatternName(p.text);
      if (!verdict.accept) {
        gateStats.rejected++;
        gateStats.byReason[verdict.reason] = (gateStats.byReason[verdict.reason] || 0) + 1;
        continue;
      }
      gateStats.accepted++;
      // Resolve through the compatibility lookup, NOT patternId() directly: an
      // index written before the id fix holds its patterns under the old
      // truncated key, and indexing with the new id would start a second entry
      // for a pattern that already has evidence. See findStoredPatternEntry.
      const id = findStoredPatternEntry(p.text, index) || patternId(p.text);
      const src = patternSource(e, dateStr);
      // W1: store the DECLARED domains plus whatever the text supports. Done
      // here, at the point where a session's patterns are collected, so every
      // downstream reader — status, query, the index on disk — sees the same
      // domains. Doing it in one place matters: inferring in computeStatus
      // instead would leave the stored entry and the status computation
      // disagreeing, which is the class of bug this file keeps having.
      const domains = effectiveDomains(p.text, p.domains);
      if (!sessionPatterns.has(id)) {
        sessionPatterns.set(id, { name: p.text, domains: new Set(domains), sources: [src] });
      } else {
        for (const d of domains) sessionPatterns.get(id).domains.add(d);
        // One source per distinct dispatch. A pattern that recurs in six entries
        // of the SAME task is one piece of evidence, not six, so the list is
        // keyed on (taskId, session) rather than appended blindly — otherwise
        // evidenceCount and sources.length would silently disagree.
        const seen = sessionPatterns.get(id).sources;
        if (!seen.some((x) => x.taskId === src.taskId && x.session === src.session)) seen.push(src);
      }
    }
  }
  const promoted = [];
  for (const [rawId, sp] of sessionPatterns) {
    // Fragmentation guard: reuse an existing entry when this is the same pattern
    // under different wording, so evidence doesn't split below the threshold.
    const nearDup = findNearDuplicatePatternId(sp.name, index);
    // Object.hasOwn, NOT a truthiness test. `index.patterns` is a plain object
    // parsed from JSON, so `index.patterns['constructor']` returns the INHERITED
    // Object constructor — truthy — and the "already exists" branch then ran
    // against a function: `p.sessions.includes` threw
    // "Cannot read properties of undefined (reading 'includes')". Reproduced via
    // patternId('constructor') === 'constructor', i.e. any session whose model
    // wrote the word "constructor" as a pattern name. The same own-property
    // guard is applied to the read on the next line, because fixing only the
    // branch test would leave the lookup itself still returning the inherited
    // function.
    const id = Object.hasOwn(index.patterns, rawId) ? rawId : (nearDup || rawId);
    let p = Object.hasOwn(index.patterns, id) ? index.patterns[id] : undefined;
    if (p) {
      if (!p.sessions.includes(dateStr)) { p.sessions.push(dateStr); p.evidenceCount++; }
      for (const d of sp.domains) if (!p.domains.includes(d)) p.domains.push(d);
      p.lastSeen = now;
      // Merge this session's dispatch sources into the stored list, same
      // (taskId, session) dedup rule used when collecting them.
      p.sources = p.sources || [];
      for (const s of sp.sources || []) {
        if (!p.sources.some((x) => x.taskId === s.taskId && x.session === s.session)) p.sources.push(s);
      }
      if (id !== rawId && sp.name !== p.name) {
        p.nameVariations = p.nameVariations || [];
        if (!p.nameVariations.includes(sp.name)) p.nameVariations.push(sp.name);
      }
    } else {
      p = index.patterns[id] = {
        name: sp.name, domains: [...sp.domains], sessions: [dateStr], evidenceCount: 1,
        status: 'candidate', firstSeen: now, lastSeen: now, correspondences: [], contradictions: [], nameVariations: [],
        implicatedBy: [],
        // The audit trail. Without this a promoted pattern has no link back to
        // the dispatch that produced it, so the only way to ask "why is this
        // here?" was to re-read every session file by hand — which is exactly
        // how the 24 quarantined patterns ended up needing manual adjudication.
        sources: [...(sp.sources || [])],
      };
    }
    promoted.push(id);
  }
  // ── Implicature pass: the WHOLE index, not just this session's patterns ───
  // This must be a separate loop over every pattern. A contradiction routinely
  // names a pattern the session never re-invoked — that is the normal shape,
  // since an agent contradicts something it read rather than something it just
  // asserted. Recording implicatedBy only for re-invoked patterns silently
  // dropped those, and the status pass below then had nothing to act on.
  //
  // THE CLAIM GATE, ON THE PROMOTION PATH TOO — and this arm is not redundant
  // with the write-path gate in appendWorkingMemory. That gate keeps NEW noise
  // out; it cannot reach records already sitting on disk. Gating the write
  // path alone leaves every one of the 568 contradiction records the greeting
  // benchmark already wrote exactly where it was, still freezing exactly the
  // same 94 patterns. This arm is what actually heals the existing corpus.
  //
  // BOTH ARMS OF THE PAIR MUST PASS. A contradiction whose two claims are
  // "The greeting is a casual salutation" / "The greeting is not a casual
  // salutation" is a true statement about a subject with nothing behind it, and
  // freezing real knowledge on it is the whole defect. The gate rejects both
  // halves, so the record is discarded before it implicates anything.
  //
  // The rejection is counted, not silent, for the same reason patternGate is:
  // an operator has to be able to ask "what stopped this pattern from
  // establishing" and get an answer instead of a gap.
  const cgStats = (index.meta.claimGate ||= { accepted: 0, rejected: 0, byReason: {} });
  const admitted = [];
  for (const c of working.contradictions) {
    // A record whose claim text the gate rejects is not evidence of a conflict
    // about anything. Assess BOTH halves: a clean claim contradicted by noise
    // is still noise doing the damage.
    const vn = typeof c.newClaim === 'string' ? assessClaim({ text: c.newClaim }) : { accept: true };
    const ve = typeof c.existingClaim === 'string' ? assessClaim({ text: c.existingClaim }) : { accept: true };
    if (vn.accept && ve.accept) { cgStats.accepted++; admitted.push(c); continue; }
    cgStats.rejected++;
    const why = vn.reason || ve.reason;
    cgStats.byReason[why] = (cgStats.byReason[why] || 0) + 1;
  }
  for (const p of Object.values(index.patterns)) {
    p.implicatedBy = p.implicatedBy || [];
    if (admitted.some(c => isImplicatedBy(p.name, c)) && !p.implicatedBy.includes(dateStr)) {
      p.implicatedBy.push(dateStr);
      const flag = `unresolved contradiction in session ${dateStr}`;
      if (!p.contradictions.includes(flag)) p.contradictions.push(flag);
    }
  }
  // ── Status pass: ONE loop, ONE rule, over the WHOLE index ────────────────
  // Demotion used to scan every pattern while restoration only ran for patterns
  // re-invoked in this session, so a demoted pattern that went quiet stayed at
  // candidate forever while an identical one that happened to be re-invoked
  // recovered. Asymmetric scans, asymmetric outcomes. Now every pattern is
  // re-evaluated against computeStatus() and moved to the position that
  // function returns, whether that is up or down.
  //
  // The corollary is that a later clean session CLEARS an earlier freeze — that
  // is the recovery path, and it needs no inverse operation and no resolution
  // field, because the evidence itself is what clears it.
  const demoted = [], restored = [];
  for (const [id, p] of Object.entries(index.patterns)) {
    const want = computeStatus(p);
    if (want === p.status) continue;
    if (want === 'established') {
      restorePattern(index, id, `cleared by evidence through ${lastEvidenceDate(p) || 'unknown'}`);
      restored.push(id);
    } else {
      demotePattern(index, id, `unresolved contradiction in session ${lastImplicationDate(p) || 'unknown'}`);
      demoted.push(id);
    }
  }
  // ── W1: make "held back" a number an operator can read ───────────────────
  // The 3-session / 2-domain bar means a pattern can be doing everything right
  // and still never establish, and until this bag existed there was no way to
  // tell that apart from "nothing is being promoted". The bar is UNCHANGED;
  // what changes is that its cost is REPORTED. Each pattern is classified by
  // the specific reason it is not established, so "why is my memory full of
  // candidates" is a count rather than a re-derivation by hand.
  //
  // Placed AFTER the status pass on purpose: the whole-index sweep above has
  // just moved patterns between candidate and established, and a bag computed
  // before it would report the previous session's verdicts as this one's.
  //
  // Recomputed whole-index every promote rather than accumulated, so it always
  // describes the index as it stands instead of drifting as patterns resolve.
  const trustStats = (index.meta.trustGate ||= {
    assessed: 0, established: 0, candidates: 0, heldBack: {}, domainsShort: 0, sessionsShort: 0,
  });
  trustStats.assessed = 0; trustStats.established = 0; trustStats.candidates = 0;
  trustStats.heldBack = {}; trustStats.domainsShort = 0; trustStats.sessionsShort = 0;
  for (const p of Object.values(index.patterns)) {
    trustStats.assessed++;
    if (p.status === 'established') { trustStats.established++; continue; }
    trustStats.candidates++;
    const sessionsShort = (p.sessions || []).length < 3;
    const domainsShort = (p.domains || []).length < 2;
    if (sessionsShort) trustStats.sessionsShort++;
    if (domainsShort) trustStats.domainsShort++;
    // The specific combination, so "every candidate is short on sessions" and
    // "every candidate is short on domains" are distinguishable — those need
    // different fixes, and a single total would hide the difference.
    const ev = lastEvidenceDate(p), im = lastImplicationDate(p);
    const frozen = !!(im && (!ev || im >= ev));
    const key = `${sessionsShort ? 'insufficientSessions' : 'ok.sessions'}`
      + `+${domainsShort ? 'insufficientDomains' : 'ok.domains'}`
      + `${frozen ? '+unresolvedContradiction' : ''}`;
    trustStats.heldBack[key] = (trustStats.heldBack[key] || 0) + 1;
  }
  trustStats.lastSession = dateStr;

  // session-level correspondences attach to the referenced pattern (flat list, no graph edges)
  for (const e of working.entries) {
    for (const corr of e.correspondences || []) {
      const m = String(corr).match(/(?:↔|corresponds to)\s*(.+?)(?:\s+in\s+\w+)?$/i);
      if (!m) continue;
      // Same compatibility requirement as the promotion path: a correspondence
      // naming a pattern stored under a pre-fix key must still find it.
      const corrId = findStoredPatternEntry(m[1], index);
      const p = corrId !== null ? index.patterns[corrId] : undefined;
      if (p && !p.correspondences.includes(corr)) p.correspondences.push(corr);
    }
  }
  // Contradiction-detection observability. Without this there is no way to tell whether
  // the detector is finding real conflicts or silently passing everything — the
  // decompositionStats side had visibility, this side did not.
  const st = index.meta.contradictionStats || (index.meta.contradictionStats = { sessionsChecked: 0, claimsChecked: 0, flagsRaised: 0 });
  st.sessionsChecked++;
  st.claimsChecked += working.entries.reduce((n, e) => n + (e.claims?.length || 0), 0);
  st.flagsRaised += working.contradictions.length;
  st.lastSession = dateStr;

  index.meta.promotions = (index.meta.promotions || 0) + 1;
  // B3: THE SAVE RESULT IS NOT DISCARDED.
  //
  // This used to be `savePatternsIndex(index);` with the boolean dropped on the
  // floor, and the function returned
  //
  //   { date, promoted: ['verify-the-store-after-a-merge-that-never-landed'],
  //     demoted: [], consolidated: [], patternCount: 1 }
  //
  // while the index file did not exist. Measured: returned in 2786ms reporting
  // a promoted pattern, `index file written? false`. The caller is told the
  // promotion happened; disk says it did not. Same class as the id-truncation
  // defect — a success signal that outruns the fact it reports.
  //
  // Reported in the return value as `saved`, rather than thrown, and that is a
  // deliberate choice. savePatternsIndex already swallows real I/O failures so
  // the per-response write path degrades instead of 500ing — the comment above
  // it says so. Throwing here would convert a read-only disk into a failed
  // response, which is the worse failure and the one that path exists to
  // prevent. The contract becomes: the return value always says whether the
  // write landed, and the caller decides.
  const saved = savePatternsIndex(index);
  return {
    date: dateStr, promoted, demoted, consolidated, saved,
    patternCount: Object.keys(index.patterns).length,
  };
}

// ── Pattern query ──────────────────────────────────────────────────────────

// MIN_QUERY_TERM is 2, not 3.
//
// The previous filter was `t.length > 2`, which silently discarded every
// one- and two-character term with no return channel at all — the caller
// cannot distinguish "your query matched nothing" from "I ignored most of
// your query". Measured: `queryPatterns('ui')` returned 0 hits while the write
// path's own normalizer maps 'ui' -> 'design', and the only stored pattern
// containing the domain 'design' was invisible to a search for it. A 2-char
// domain term is the exact case this vocabulary is built on.
export const MIN_QUERY_TERM = 2;

export function queryPatterns(query, index, options = {}) {
  const raw = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const terms = [];
  // A query term that IS a domain synonym must be searched as the domain the
  // index actually stores. The write path normalizes every domain through
  // normalizeDomain, so 'ui' is persisted as 'design'; a literal substring
  // search for 'ui' can never match it. That was the review's concrete
  // example — `queryPatterns('ui')` returning nothing for the one pattern
  // whose domain was 'design' — and it is the same class of bug as the silent
  // drop: the caller's words are present and the answer is wrong.
  //
  // Both forms are searched, so this widens matching rather than narrowing it.
  for (const t of raw) {
    if (t.length < MIN_QUERY_TERM) continue;
    if (!terms.includes(t)) terms.push(t);
    const normalized = normalizeDomain(t);
    // Only add the synonym when it is a real domain, never 'other' — mapping
    // an unknown word to 'other' would match every unrelated pattern.
    if (normalized !== 'other' && normalized !== t && !terms.includes(normalized)) terms.push(normalized);
  }
  // Reported, never silently applied. A caller can always ask why a query
  // matched nothing, which is the whole difference between a search function
  // and a guess.
  const dropped = raw.filter(t => t.length < MIN_QUERY_TERM);

  const { status = null, limit = 10, explain = false } = options;

  // A query made ENTIRELY of dropped terms is a different failure from one
  // with nothing to search: returning [] would be indistinguishable from "no
  // match", so with explain the reason comes back explicitly.
  if (!terms.length) {
    return explain ? { results: [], explain: { terms, dropped, reason: 'allTermsDropped' } } : [];
  }

  const results = [];
  for (const [id, p] of Object.entries(index.patterns || {})) {
    // TRUST IS EXPRESSIBLE NOW. Before this there was no way to ask the
    // question that matters most about a memory index: "which of these am I
    // actually allowed to rely on?" A caller got every candidate and no
    // indication of which had earned anything, so a caller who cared had to
    // filter by hand — and got it wrong often enough that nobody did.
    if (status && p.status !== status) continue;
    const hay = `${p.name} ${(p.domains || []).join(' ')}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    if (score > 0) results.push({ id, name: p.name, domains: p.domains, sessions: p.sessions, evidenceCount: p.evidenceCount, status: p.status, score });
  }
  const sorted = results.sort((a, b) => b.score - a.score || b.evidenceCount - a.evidenceCount).slice(0, limit);
  // Default shape unchanged — an array — so every existing caller is
  // unaffected. The explanation is opt-in, because changing the return type
  // would break callers who iterate the result directly.
  return explain ? { results: sorted, explain: { terms, dropped, reason: null } } : sorted;
}
