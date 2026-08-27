// Board grouping: one level of nesting derived from the fetched cards alone —
// children under the requirement they decompose, orphans promoted, and the
// per-row progress the parent line reports.
import { describe, expect, it } from 'vitest'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { CardLocation, DevCard } from '@zhchxiao123/dsh-devflow/client'
import { groupByParent, isActive, ordered } from '../src/client/board.ts'

function card(id: string, stage: CardLocation = 'developing', parent?: string): DevCard {
  return {
    id: DevflowCardId(id),
    root: '/ws/.devflow',
    title: `Card ${id}`,
    stage,
    stageRevision: 4,
    ...parent === undefined ? {} : { parent: DevflowCardId(parent) },
    body: '',
    path: `tasks/${id}/card.md`,
    artifacts: [],
  }
}

describe('board grouping', () => {
  it('nests children under their parent and reports the parent\'s progress', () => {
    const rows = groupByParent([
      card('0003-slice-b', 'blocked', '0001-big'),
      card('0004-standalone', 'ready'),
      card('0001-big', 'developing'),
      card('0002-slice-a', 'done', '0001-big'),
    ])
    expect(rows.map(row => row.card.id)).toEqual(['0001-big', '0004-standalone'])
    expect(rows[0].children.map(child => child.id)).toEqual(['0003-slice-b', '0002-slice-a'])
    expect(rows[0]).toMatchObject({ doneChildren: 1, blockedChildren: true })
    expect(rows[1]).toMatchObject({ children: [], doneChildren: 0, blockedChildren: false })
  })

  it('promotes an orphan child so no card can vanish from the board', () => {
    const rows = groupByParent([card('0006-orphan', 'developing', '0099-archived')])
    expect(rows.map(row => row.card.id)).toEqual(['0006-orphan'])
    expect(rows[0].children).toEqual([])
  })

  it('orders active cards before done ones at both levels', () => {
    const rows = groupByParent([
      card('0001-done-parent', 'done'),
      card('0002-open-parent', 'draft'),
      card('0003-done-child', 'done', '0002-open-parent'),
      card('0004-open-child', 'reviewing', '0002-open-parent'),
    ])
    expect(rows.map(row => row.card.id)).toEqual(['0002-open-parent', '0001-done-parent'])
    expect(rows[0].children.map(child => child.id)).toEqual(['0004-open-child', '0003-done-child'])
    expect(ordered([]).length).toBe(0)
    expect(isActive(card('0005-x', 'done'))).toBe(false)
  })
})
