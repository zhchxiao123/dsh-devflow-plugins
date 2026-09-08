import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('the deploy bundle patch', () => {
  it('keeps an unconfigured installation disabled and bootable', async () => {
    const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(parse(source)).toEqual([{
      insert: [{
        id: 'deploy',
        name: '@zhchxiao123/dsh-devflow-deploy',
        disabled: true,
      }],
    }])
  })
})
