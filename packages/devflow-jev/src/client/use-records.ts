import { useCallback, useEffect, useRef, useState } from 'react'
import type { JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import type { AuditSummary, EvaluationSummary } from '../types.ts'
import { request, type ProjectContext } from './api.ts'
export interface ReviewData {
  context?: ProjectContext
  audits?: AuditSummary[]
  runs?: JevRunSnapshot[]
  evaluations?: EvaluationSummary[]
}
export function useRecords(sessionId: string, visible: boolean, refreshMs: number) {
  const [data, setData] = useState<ReviewData>({})
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const current = useRef<AbortController>()
  const refresh = useCallback(async () => {
    current.current?.abort()
    const controller = new AbortController()
    current.current = controller
    setLoading(true)
    const failures: string[] = []
    const capture = async <T>(operation: Promise<T>): Promise<T | undefined> => {
      try {
        return await operation
      } catch (error) {
        if (!controller.signal.aborted) failures.push(String(error))
        return undefined
      }
    }
    const contextPromise = capture(request({ method: 'context', sessionId }, controller.signal))
    const auditsPromise = capture(request({ method: 'audit-list', sessionId }, controller.signal))
    const evaluationsPromise = capture(request({ method: 'list', sessionId }, controller.signal))
    const context = await contextPromise
    const runsPromise =
      context?.genericRunsAvailable === true
        ? capture(request({ method: 'run-list', sessionId }, controller.signal))
        : Promise.resolve(context?.genericRunsAvailable === false ? [] : undefined)
    const [audits, evaluations, runs] = await Promise.all([auditsPromise, evaluationsPromise, runsPromise])
    if (controller.signal.aborted) return
    setData(previous => ({
      ...previous,
      ...(context === undefined ? {} : { context }),
      ...(audits === undefined ? {} : { audits }),
      ...(evaluations === undefined ? {} : { evaluations }),
      ...(runs === undefined ? {} : { runs }),
    }))
    setErrors(failures)
    setLoading(false)
    current.current = undefined
  }, [sessionId])
  useEffect(() => {
    if (!visible) return
    const tick = () => {
      if (document.visibilityState === 'hidden') {
        current.current?.abort()
        current.current = undefined
        setLoading(false)
      } else if (current.current === undefined) void refresh()
    }
    tick()
    const timer = window.setInterval(tick, refreshMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
      current.current?.abort()
      current.current = undefined
    }
  }, [visible, refreshMs, refresh])
  useEffect(
    () => () => {
      current.current?.abort()
    },
    [],
  )
  return { data, errors, loading, refresh }
}
