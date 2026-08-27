/**
 * The devflow bundle: a package whose substance is `cordis.patch.yml`, not
 * code. Installing it into a profile is what mounts the whole plugin line —
 * `dsh plugin add` reconciles the profile's bundle stack against installed
 * packages, and a dependency declaring `dsh.bundle` joins that stack.
 *
 * The plugin body is empty on purpose. The patch mounts each devflow plugin as
 * its own row, so a deployment keeps every per-row control it would have had
 * composing them by hand: disable a row, re-`config` it, or drop it entirely.
 * A bundle that also registered behavior would take that away.
 * @module @zhchxiao123/dsh-devflow-bundle
 */

/** Bundle plugin body — the mount list is the patch, not this function. */
export function apply(): void {}
