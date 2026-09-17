import { Component, type ReactNode } from 'react'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** Rendering faults stay inside this plugin's page instead of replacing the Harness shell. */
export class PanelBoundary extends Component<{ children: ReactNode; t: Translate }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div className={css.page}><div role="alert" className={css.error}>{this.props.t('renderError')}<button onClick={() => { this.setState({ failed: false }) }}>{this.props.t('refresh')}</button></div></div>
  }
}
