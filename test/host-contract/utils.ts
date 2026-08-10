/**
 * Compile-time-only type utilities for the host-contract fixture.
 *
 * `Equal` and `Assert` are the standard TS utility types used by the PR 4
 * host-contract typecheck fixture (docs/CRIP/PR-4/implementation-plan.md §10).
 * They are erased at runtime and exist purely to pin the host type surface.
 */

/** True only when X and Y are the exact same type. */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true : false

/** Compile error unless T is exactly `true`. */
export type Assert<T extends true> = T
