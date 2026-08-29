//#region src/invariant.d.ts
/** Invariant companion plugin (no assertions — nothing to check at runtime). */
/** Provides no assertions: the board owns no cross-package runtime invariants. */
declare function apply(): void;
//#endregion
export { apply };