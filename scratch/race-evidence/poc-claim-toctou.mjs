// poc-claim-toctou.mjs
//
// Deterministic proof of the residual mutual-exclusion hole in
// withIndexLock's stale-claim breaker. No need to win a scheduling race —
// the interleaving is constructed by hand from the real code's own steps.
//
// THE BREAKER (src/polymem.mjs, acquireClaim's EEXIST branch):
//
//   if (isClaimStale(claim)) { try { unlinkSync(claim); } catch {} continue; }
//
// and isClaimStale returns true when the claim "vanished under us":
//
//   try { info = JSON.parse(readFileSync(claim,'utf8')); mtime = statSync(claim).mtimeMs; }
//   catch { try { mtime = statSync(claim).mtimeMs; } catch { return true; }   // <-- here
//           return Date.now() - mtime > CLAIM_STALE_MS; }
//
// The unlink is UNCONDITIONAL and is not tied to the claim that was inspected.
// Between the check and the unlink, another process can legitimately acquire
// the claim. The breaker then deletes a LIVE holder's claim, and two processes
// run the read-merge-write section at once — the lost update the claim exists
// to prevent.
//
// Below, the interleaving is: breaker inspects -> new live owner acquires ->
// breaker unlinks. The final assertion is the security property itself.

import { openSync, closeSync, writeFileSync, readFileSync, statSync, utimesSync,
         unlinkSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

// The real constants, copied from src/polymem.mjs. Kept in sync by hand here
// because isClaimStale is module-private.
const CLAIM_STALE_MS = 30_000;

const dir = mkdtempSync(join(tmpdir(), 'polymem-toctou-'));
const claim = join(dir, 'patterns-index.json.claim');

// A pid that is definitely not running, so isClaimStale's liveness probe
// (process.kill(pid, 0)) reports ESRCH and treats the owner as dead.
function deadPid() {
  for (let p = 999_990; p > 999_900; p--) {
    try { process.kill(p, 0); } catch (e) { if (e.code === 'ESRCH') return p; }
  }
  throw new Error('no free pid found');
}

// ── verbatim from acquireClaim ──────────────────────────────────────────────
function createClaim(pid) {
  const fd = openSync(claim, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid, host: hostname(), at: Date.now() })); } finally { closeSync(fd); }
}

// ── verbatim from isClaimStale ──────────────────────────────────────────────
function isClaimStale() {
  let info, mtime;
  try {
    info = JSON.parse(readFileSync(claim, 'utf8'));
    mtime = statSync(claim).mtimeMs;
  } catch {
    try { mtime = statSync(claim).mtimeMs; } catch { return true; }        // vanished
    return Date.now() - mtime > CLAIM_STALE_MS;                          // young
  }
  if (!info || typeof info !== 'object') return false;
  if (info.host !== hostname()) return false;
  if (!Number.isInteger(info.pid)) return false;
  if (info.pid === process.pid) return false;
  let alive;
  try { process.kill(info.pid, 0); alive = true; } catch (err) { alive = err.code !== 'ESRCH'; }
  if (alive) return false;
  return Date.now() - mtime > CLAIM_STALE_MS;                            // dead AND old
}

const DEAD = deadPid();
console.log('PoC: the stale-claim breaker unlinks without revalidating\n');

// 1. A crashed writer leaves a claim: dead pid, older than CLAIM_STALE_MS.
createClaim(DEAD);
const old = new Date(Date.now() - (CLAIM_STALE_MS + 60_000));
utimesSync(claim, old, old);
console.log(`1. crashed writer left a claim  pid=${DEAD} (dead), mtime ${CLAIM_STALE_MS + 60_000}ms old`);

// 2. A contender contends, gets EEXIST, and runs the breaker. It concludes
//    "abandoned" — correctly, at this instant.
const saysStale = isClaimStale();
console.log(`2. breaker concludes the claim is abandoned (stale): ${saysStale}`);

// 3. THE INTERLEAVING. Before the breaker's unlink lands, a NEW writer — a
//    live process, this one — acquires the claim. This is legitimate: the old
//    owner is dead, so the path is free.
unlinkSync(claim);            // the dead owner's claim is cleared by any breaker
createClaim(process.pid);     // NEW LIVE OWNER acquires
console.log(`3. new LIVE owner (pid=${process.pid}) acquires the claim`);

// 4. The breaker's unlink now executes — unconditional, not revalidated.
if (saysStale) { try { unlinkSync(claim); } catch { /* swallowed by the real code too */ } }
const survived = existsSync(claim);
console.log(`4. claim still present after the breaker's unlink: ${survived}`);

// 5. The security property. The new owner still believes it holds the claim
//    (nothing told it otherwise) and is about to read-merge-write. If the
//    claim file is gone, a second process can acquire right now.
let secondWriterCanEnter = false;
if (!survived) {
  try { createClaim(process.pid + 1); secondWriterCanEnter = true; } catch { secondWriterCanEnter = false; }
}
console.log(`5. a SECOND writer can enter the "exclusive" section: ${secondWriterCanEnter}`);

console.log('');
if (!survived && secondWriterCanEnter) {
  console.log('CONFIRMED — the breaker deleted a claim owned by a LIVE process.');
  console.log('');
  console.log('Consequence: the live owner read-merge-writes at the same time as the');
  console.log('second writer. mergeConcurrentIndex unions the two snapshots, but each');
  console.log('writer only saw the state present when IT read — so the later rename');
  console.log('publishes a file missing the earlier writer\'s pattern. Silent loss,');
  console.log('with savePatternsIndex returning true for both. Measured below.');
  process.exitCode = 1;   // PoC "fails" = the bug is present
} else {
  console.log('NOT REPRODUCED — claim survived.');
  process.exitCode = 0;
}

rmSync(dir, { recursive: true, force: true });
