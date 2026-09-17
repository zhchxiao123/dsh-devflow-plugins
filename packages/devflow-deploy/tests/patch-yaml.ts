/**
 * A `cordis.patch.yml` parser for specs outside this package.
 *
 * `yaml` is a devDependency of this package rather than of the repository
 * root, so a root spec has no specifier that resolves it; resolution happens
 * here, where the dependency is declared. This package is the host because
 * `bundle-patch.spec.ts` beside it is already the one spec that parses a
 * bundle patch.
 *
 * The result is `unknown` rather than `yaml`'s `any`: a caller that wants
 * structure states it at its own boundary instead of inheriting one from here.
 */

import { parse } from 'yaml'

/**
 * Parse one patch document.
 * @param source - the file's contents.
 * @returns the parsed value.
 */
export function parsePatchYaml(source: string): unknown {
  return parse(source)
}
