/** Publish SDK reports that work in an opaque-origin sandbox without granting host storage access. */
import { readFile, writeFile } from 'node:fs/promises'

// Run before the SDK's first script. These per-document maps never read cookies or native Web Storage.
const MEMORY_STORAGE = `<script data-devflow-report-storage>
(()=>{for(const name of ['localStorage','sessionStorage']){const values=new Map();const storage={get length(){return values.size},key(index){return [...values.keys()][Number(index)]??null},getItem(key){return values.get(String(key))??null},setItem(key,value){values.set(String(key),String(value))},removeItem(key){values.delete(String(key))},clear(){values.clear()}};Object.defineProperty(globalThis,name,{value:storage,configurable:false,writable:false})}})();
</script>`

/** Preserve the original SDK dump and UI; only substitute document-lifetime storage before SDK startup. */
export function sandboxReportHtml(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) {
    const offset = head.index + head[0].length
    return html.slice(0, offset) + MEMORY_STORAGE + html.slice(offset)
  }
  return MEMORY_STORAGE + html
}

/** Write stable published bytes; HTTP delivery must serve this file unchanged. */
export async function publishReportHtml(source: string, destination: string): Promise<void> {
  await writeFile(destination, sandboxReportHtml(await readFile(source, 'utf8')), { mode: 0o600 })
}
