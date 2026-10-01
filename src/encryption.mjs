// encryption.mjs — optional encryption at rest for Polymem's JSON stores.
//
// WHY THIS IS A SEPARATE MODULE rather than inline in polymem.mjs: the crypto
// seam has to be testable on its own, and it has to be the ONE place that
// decides whether a byte string is plaintext or ciphertext. Two rules that both
// stores obey, enforced by construction rather than by remembering.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
// It does not manage keys. The passphrase arrives in an environment variable and
// this module never stores, logs, derives-from-anything-else, or recovers it.
// There is no keyring, no rotation, no escrow, and no recovery path, because a
// library that ships those is a secrets manager with a memory file attached, and
// this package's entire premise is that it is a file library with no
// dependencies. If the passphrase is lost, the data is gone. That is stated in
// the README in those words rather than softened here.
//
// ── THE FORMAT ───────────────────────────────────────────────────────────────
// A sealed file is ONE line:
//
//   POLYMEM-ENC-V1 <base64 of a JSON envelope>
//
// and the envelope is JSON so it stays inspectable with `head` and decodable
// without this package. One line, because a multi-line header invites a partial
// write to parse as a valid prefix; the whole payload still goes through
// writeFileAtomic, but the format should not need that guarantee to be sane.
//
// The magic prefix is what makes backwards compatibility decidable rather than
// hopeful. A plaintext index always begins with '{' (it is JSON.stringify output)
// and can never begin with these bytes, so "is this file sealed?" is answered by
// the first 16 characters and never by attempting a decrypt and seeing what
// happens. That distinction is load-bearing on the read path — see below.
//
// ── WHY A FRESH IV EVERY WRITE ───────────────────────────────────────────────
// GCM's one catastrophic misuse is reusing an IV under the same key: it leaks
// the XOR of the two plaintexts and lets forgery be computed. So the IV is
// random per write and never persisted across writes. Verified by test: two
// saves of identical data produce different ciphertext.
//
// ── WHY A PER-FILE SALT, AND WHY THAT IS STILL CORRECT ───────────────────────
// The salt lives in the envelope and is generated once per file, then reused,
// because scrypt costs ~25ms per derivation and savePatternsIndex is called on
// the decomposed-RESPONSE path in OmegaShell — re-deriving per write would put a
// 25ms stall on every memory write for the life of the deployment. The derived
// key is then cached in-process.
//
// This is safe, and the reason is worth stating because it looks wrong at a
// glance: the salt is a KDF input, not an IV. DECRYPTION ALWAYS READS THE SALT
// OUT OF THE ENVELOPE, never from the cache, so a stale cached salt cannot make
// a file undecryptable — it would at worst mean this process writes with an
// older salt, which is still a valid salt for a valid key. The per-write IV is
// the thing that must never repeat, and it does not. The one thing this design
// gives up is cross-file rainbow-table amortization against a shared passphrase,
// which is not the threat model for a local file the attacker already has.
//
// ── AAD BINDS THE HEADER ─────────────────────────────────────────────────────
// The magic string is passed as additional authenticated data, so an attacker
// cannot strip or rewrite the version prefix and have the tag still verify. The
// header is authenticated data, not metadata.

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

// First bytes of every sealed file. Chosen so it cannot collide with JSON
// output (which always starts with '{').
const MAGIC = 'POLYMEM-ENC-V1';
const SEP = ' ';

// scrypt parameters, recorded in the envelope so a future default change does
// not make existing files undecryptable. These are Node's own scrypt defaults
// (N=16384, r=8, p=1), stated explicitly rather than inherited so that
// bumping them later is a deliberate, visible edit to a written record.
const KDF = 'scrypt';
const KDF_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

// Thrown when a sealed file cannot be opened. Distinct from a JSON parse error
// on purpose: the caller's response to "this is the wrong passphrase" must not
// be the same as its response to "this file is corrupt", and neither may be
// the same as its response to "this file does not exist yet".
export class DecryptionError extends Error {
  constructor(reason, detail) {
    const what = {
      'no-key': `this file is encrypted at rest but ${PASSPHRASE_ENV} is not set in this process`,
      'auth': 'decryption failed the authentication check: wrong passphrase, or the file has been modified since it was written',
      'malformed': 'this file is marked as encrypted but its header or payload is malformed',
    }[reason] || 'decryption failed';
    super(`polymem: cannot decrypt ${detail || 'the store'}: ${what}. ` +
      `The data on disk is untouched — nothing has been overwritten — but this ` +
      `process will not guess. Set ${PASSPHRASE_ENV} to the passphrase that ` +
      `wrote the file, or point ${'OMEGA_MEMORY_INDEX'} at the right path. ` +
      `If the passphrase is lost the file cannot be recovered by any means.`);
    this.name = 'DecryptionError';
    this.code = 'DECRYPTION_FAILED';
    this.reason = reason;
  }
}

// Declared after the class so the message template can name it. The env var is
// the documented seam; keeping it in one place means the README, the error text,
// and the read path cannot disagree about what it is called.
export const PASSPHRASE_ENV = 'OMEGA_MEMORY_PASSPHRASE';

const b64 = (buf) => buf.toString('base64');
const unb64 = (str) => Buffer.from(String(str), 'base64');

// Derived keys, keyed by `${saltHex}:${passphrase}`. Bounded because the key
// space is "files in this process", and a Map that grows without limit in a
// long-lived server is a slow leak. 64 covers a host with far more memory files
// than any single process should be opening; past that the oldest entry is
// dropped and simply re-derived.
const keyCache = new Map();
const KEY_CACHE_MAX = 64;

function deriveKey(passphrase, salt) {
  // Constant-time on the lookup key would be theatre here — the cache key is a
  // salt plus a secret, and a miss/miss timing difference does not reveal the
  // passphrase any more than the derive itself does.
  const cacheKey = `${salt.toString('hex')}:${passphrase}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = scryptSync(passphrase, salt, KDF_PARAMS.keylen, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p,
  });
  if (keyCache.size >= KEY_CACHE_MAX) {
    keyCache.delete(keyCache.keys().next().value);
  }
  keyCache.set(cacheKey, key);
  return key;
}

// Does this text look like a sealed file? Answered from the first bytes only,
// and never by attempting a decrypt — a decrypt attempt is what makes the
// wrong-key case look like a corrupt file.
export function isSealed(text) {
  return typeof text === 'string' && text.startsWith(MAGIC + SEP);
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || !passphrase.trim()) {
    throw new DecryptionError('no-key');
  }
  return passphrase;
}

// Seal a plaintext string. Returns the single-line sealed form.
//
// salt may be supplied by the caller to keep a file's salt stable across
// writes; callers that omit it get a fresh random salt. Either way the IV is
// always freshly random — see the header on why.
export function seal(plaintext, passphrase, salt) {
  assertPassphrase(passphrase);
  const useSalt = salt || randomBytes(16);
  const key = deriveKey(passphrase, useSalt);
  const iv = randomBytes(12);                      // 96 bits, the GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(MAGIC));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = {
    v: 1,
    kdf: KDF,
    ...KDF_PARAMS,
    salt: b64(useSalt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ct: b64(ct),
  };
  return `${MAGIC}${SEP}${b64(Buffer.from(JSON.stringify(envelope), 'utf8'))}\n`;
}

// Open a sealed file. Throws DecryptionError — never returns partial or empty
// data. This is the single most important property in the module: a caller that
// received '' here would treat it as an empty store and could overwrite real
// data with it.
export function open(text, passphrase, detail) {
  if (!isSealed(text)) throw new DecryptionError('malformed', detail);

  let envelope;
  try {
    envelope = JSON.parse(unb64(text.slice(MAGIC.length + SEP.length).trim()).toString('utf8'));
  } catch {
    throw new DecryptionError('malformed', detail);
  }
  if (!envelope || typeof envelope.ct !== 'string' || typeof envelope.tag !== 'string'
      || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string') {
    throw new DecryptionError('malformed', detail);
  }
  // The salt comes from the FILE, never from the process cache. See header.
  let plaintext;
  try {
    const key = deriveKey(assertPassphrase(passphrase), unb64(envelope.salt));
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(envelope.iv));
    decipher.setAAD(Buffer.from(MAGIC));
    decipher.setAuthTag(unb64(envelope.tag));
    plaintext = Buffer.concat([decipher.update(unb64(envelope.ct)), decipher.final()]).toString('utf8');
  } catch (e) {
    // Two very different failures land here — a wrong passphrase and a flipped
    // ciphertext byte both fail the GCM tag, and GCM cannot tell them apart.
    // That is not a gap to paper over: it is the guarantee. We say "wrong key OR
    // modified file" rather than guessing, because guessing wrong is how an
    // operator is sent to re-key a file that was actually tampered with.
    // A missing passphrase is separated out because it is not ambiguous.
    if (e instanceof DecryptionError) throw e;
    throw new DecryptionError('auth', detail);
  }
  return plaintext;
}
