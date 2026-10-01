// src/index.mjs — Polymem barrel export
// Re-exports everything from src/polymem.mjs so consumers can `import { ... } from 'polymem'`.
export {
  normalizeDomain,
  patternId,
  // The pre-fix id scheme and the lookup that bridges to it. Exported so a
  // caller migrating an index, or a reviewer checking the compatibility story,
  // can reach them without reaching into the module's internals.
  legacyPatternId,
  findStoredPatternEntry,
  effectiveDomains,
  findNearDuplicatePatternId,
  consolidateNearDuplicates,
  demotePattern,
  restorePattern,
  loadPatternsIndex,
  savePatternsIndex,
  parseMemoryBlock,
  workingMemoryPath,
  loadWorkingMemory,
  saveWorkingMemory,
  assessClaim,
  assessPatternName,
  stampProvenance,
  isImplicatedBy,
  checkIntraSessionContradictions,
  appendWorkingMemory,
  QuarantineError,
  // Concurrent-save API. removeMetaKey is REQUIRED to remove a meta key: the
  // save merge reads an absent key as "never seen" and would restore it.
  removeMetaKey,
  mergeConcurrentIndex,
  withIndexLock,
  ContentionError,
  computeStatus,
  promoteSession,
  queryPatterns,
  MIN_QUERY_TERM,
} from './polymem.mjs';

// The encryption seam, re-exported so a consumer can catch DecryptionError by
// identity instead of matching on a message string, and can read the env var
// name from the module that enforces it instead of hardcoding a literal that
// can drift from the implementation.
export { DecryptionError, PASSPHRASE_ENV } from './encryption.mjs';
