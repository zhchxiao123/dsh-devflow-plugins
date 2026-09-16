/** Managed runs discard ambient SDK settings; standalone CLI runs retain their explicit shell configuration. */
export function childEnvironment(overrides?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  if (overrides === undefined) return { ...process.env }
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MIDSCENE_'))),
    ...overrides,
  }
}
