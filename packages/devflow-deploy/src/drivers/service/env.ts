/**
 * The compose project's `.env` as this driver treats it: one variable it owns,
 * and everything else left exactly as found.
 *
 * The file belongs to the operator — it commonly carries database URLs, ports,
 * and secrets — and this driver only points one variable at a release. Reading
 * and rewriting it wholesale would silently drop whatever else it held, so the
 * rewrite is line-preserving and every other byte survives untouched.
 */

/** Read one variable out of an env file's contents. */
export function readVar(contents: string, name: string): string | undefined {
  for (const line of contents.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(`${name}=`)) continue
    return trimmed.slice(name.length + 1).trim()
  }
  return undefined
}

/**
 * Set one variable, keeping every other line byte-for-byte.
 *
 * A file that already declares the variable has that line replaced in place;
 * one that does not gains it at the end, with a trailing newline so a later
 * append does not join onto it.
 * @param contents - the file as read; empty when it does not exist yet.
 * @param name - the variable this driver owns.
 * @param value - the release identifier to point at.
 * @returns the file to write back.
 */
export function setVar(contents: string, name: string, value: string): string {
  const assignment = `${name}=${value}`
  const lines = contents.split('\n')
  const index = lines.findIndex(line => line.trimStart().startsWith(`${name}=`))
  if (index >= 0) {
    lines[index] = assignment
    return lines.join('\n')
  }
  if (contents === '') return `${assignment}\n`
  return contents.endsWith('\n') ? `${contents}${assignment}\n` : `${contents}\n${assignment}\n`
}
