// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FormRequest } from '../src/client/forms.tsx'
import { PlanForm, SubscriptionForm } from '../src/client/forms.tsx'
import { plan, subscription, t } from './fixtures.ts'
afterEach(cleanup)
const change = (label: string, value: string): void => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
const submitForm = (label: string): void => { fireEvent.submit(screen.getByRole('form', { name: label })) }
describe('automation forms', () => {
  it('creates a repository subscription and updates its scope and credential reference', () => {
    const submit = vi.fn<(request: FormRequest) => void>(); const close = vi.fn()
    const view = render(<SubscriptionForm item={undefined} busy={false} submit={submit} close={close} t={t} />)
    change(t('repository'), 'owner/new'); change(t('credential'), 'env:NEW')
    fireEvent.click(screen.getByLabelText('Issues')); expect(screen.getByRole('button', { name: t('save') })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('Discussions')); submitForm(t('subscriptions'))
    expect(submit).toHaveBeenLastCalledWith({ method: 'subscription.save', input: { repository: 'owner/new', issues: false, discussions: true, credentialRef: 'env:NEW' } })
    fireEvent.click(screen.getByRole('button', { name: t('close') })); expect(close).toHaveBeenCalledOnce()
    view.unmount()
    render(<SubscriptionForm item={{ ...subscription(), credentialRef: 'env:OLD', issues: false, discussions: true }} busy={true} submit={submit} close={close} t={t} />)
    expect(screen.getByLabelText(t('repository'))).toHaveProperty('disabled', true)
    change(t('credential'), ''); submitForm(t('subscriptions'))
    expect(submit).toHaveBeenLastCalledWith({ method: 'subscription.save', id: 'sub', input: { repository: 'owner/sub', issues: false, discussions: true } })
  })
  it('creates interval and timezone-specific Cron schedules from a subscription selector', () => {
    const submit = vi.fn<(request: FormRequest) => void>(); const close = vi.fn()
    const view = render(<PlanForm item={undefined} subscriptions={[subscription(), subscription('second')]} busy={false} submit={submit} close={close} t={t} />)
    change(t('name'), 'Daily sync'); change(t('subscription'), 'second'); change(t('minutes'), '45'); submitForm(t('plans'))
    expect(submit).toHaveBeenLastCalledWith({ method: 'plan.save', input: { name: 'Daily sync', handler: 'github.sync', params: { subscriptionId: 'second' }, rule: { kind: 'interval', everyMs: 2700000 } } })
    change(t('rule'), 'cron'); change(t('expression'), '0 9 * * *'); change(t('timezone'), 'Asia/Shanghai'); submitForm(t('plans'))
    expect(submit.mock.lastCall?.[0]).toMatchObject({ input: { rule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' } } })
    change(t('rule'), 'interval'); fireEvent.click(screen.getByRole('button', { name: t('close') })); expect(close).toHaveBeenCalledOnce()
    view.unmount()
    render(<PlanForm item={undefined} subscriptions={[]} busy={false} submit={submit} close={close} t={t} />)
    expect(screen.getByRole('button', { name: t('save') })).toHaveProperty('disabled', true)
  })
  it('preserves generic handler parameters and execution policy while editing only a schedule', () => {
    const submit = vi.fn<(request: FormRequest) => void>()
    const item = { ...plan(), handler: 'other.worker', params: { nested: [1, true] }, misfire: 'skip' as const, maxAttempts: 4, timeoutMs: 9000 }
    const view = render(<PlanForm item={item} subscriptions={[]} busy={false} submit={submit} close={() => {}} t={t} />)
    change(t('name'), 'renamed'); submitForm(t('plans'))
    expect(submit).toHaveBeenLastCalledWith({ method: 'plan.save', id: item.id, input: { name: 'renamed', handler: item.handler, params: item.params, misfire: 'skip', maxAttempts: 4, timeoutMs: 9000, rule: item.rule } })
    view.unmount()
    render(<PlanForm item={{ ...plan(), rule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'America/Los_Angeles' } }} subscriptions={[]} busy={true} submit={submit} close={() => {}} t={t} />)
    expect(screen.getByLabelText(t('timezone'))).toHaveProperty('value', 'America/Los_Angeles')
    submitForm(t('plans')); expect(submit.mock.lastCall?.[0]).not.toHaveProperty('input.misfire')
  })
})
