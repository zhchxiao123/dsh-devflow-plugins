/**
 * The two test doubles these specs need from the harness's client test
 * runtime, restated. `@deepseek-ai/dsh-client-test-runtime` cannot be used
 * outside the harness checkout: its published `lib/index.js` imports
 * `@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts`, a path no tarball
 * ships. Both doubles are small and stable, so a copy costs less than waiting
 * on that packaging.
 */

import { vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Build a translate stub resolving through `dicts` in order, falling back to
 * the key, with `{name}` interpolation — the lookup order the locale runtime
 * uses, so a spec asserting copy asserts what a user would see.
 * @param dicts - dictionaries consulted in order.
 * @returns the translate function.
 */
export function makeTranslate(
  ...dicts: readonly Record<string, string>[]
): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    let template = key
    for (const dict of dicts) {
      const hit = dict[key]
      if (hit !== undefined) {
        template = hit
        break
      }
    }
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

/** One stubbed scope: the face under test, its write spies, and publication controls. */
export interface StubSettingsScope<T> {
  /** The scope face handed to the code under test. */
  scope: SettingsScope<T>
  /** Spy behind `scope.set`; resolves immediately. */
  set: ReturnType<typeof vi.fn>
  /** Spy behind `scope.unset`; resolves immediately. */
  unset: ReturnType<typeof vi.fn>
  /** @returns how many listeners are subscribed, for disposal assertions. */
  listenerCount: () => number
  /**
   * Replace part of the snapshot and notify subscribers, as a host acceptance would.
   * @param next - snapshot fields to replace.
   */
  publish: (next: Partial<SettingsScopeSnapshot<T>>) => void
}

/**
 * Build an in-memory settings scope: starts in the host loading state, records
 * writes, and lets a spec publish host acceptances.
 * @returns the stub handle.
 */
export function stubSettingsScope<T>(): StubSettingsScope<T> {
  let snapshot: SettingsScopeSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(() => Promise.resolve())
  const unset = vi.fn(() => Promise.resolve())
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
      unset,
    },
    set,
    unset,
    listenerCount: () => listeners.size,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}
