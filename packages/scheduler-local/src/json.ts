import { types } from 'node:util'
/** Copy lossless plain JSON without evaluating accessors or serialization hooks. */
export function copyJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('JSON_PARAMS_REQUIRED')
    return value
  }
  if (typeof value !== 'object' || types.isProxy(value)) throw new Error('JSON_PARAMS_REQUIRED')
  const array = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
    throw new Error('JSON_PARAMS_REQUIRED')
  if (ancestors.has(value)) throw new Error('JSON_PARAMS_REQUIRED')
  ancestors.add(value)
  const result: object = array ? [] : { __proto__: null }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('JSON_PARAMS_REQUIRED')
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (array && key === 'length') continue
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw new Error('JSON_PARAMS_REQUIRED')
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      throw new Error('JSON_PARAMS_REQUIRED')
    Object.defineProperty(result, key, {
      value: copyJson(descriptor.value, ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  if (array && Reflect.ownKeys(value).length !== value.length + 1) throw new Error('JSON_PARAMS_REQUIRED')
  ancestors.delete(value)
  return result
}
