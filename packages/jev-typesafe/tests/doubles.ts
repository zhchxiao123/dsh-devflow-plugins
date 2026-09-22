// Doubles for the two things this provider reaches outside itself: the
// credential seam and the network. Both are mutable between calls, because the
// behaviours under test are "re-resolved every call" and "this failure maps to
// that code".
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { TypeSafeJev } from '@zhchxiao123/dsh-jev-typesafe'

/** A credential store a spec can change between calls, and count reads on. */
export class MemoryCredentials extends CredentialProvider {
  /** Current value, or `undefined` for "not configured". */
  value: string | undefined = 'sk-test'
  /** Set to throw from `resolve`, to exercise the lookup-failed path. */
  failure: Error | undefined
  /** How many times `resolve` was called. */
  reads = 0

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.reads += 1
    if (this.failure !== undefined) throw this.failure
    return await Promise.resolve(
      this.value === undefined ? undefined : { ref, value: this.value, source: 'memory' } as ResolvedCredential,
    )
  }

  // The rest of the seam is unreachable from this provider, which only ever
  // resolves. They exist to satisfy the abstract class.
  override describe(): Promise<CredentialInfo> { return Promise.reject(new Error('unused')) }
  override set(): Promise<void> { return Promise.reject(new Error('unused')) }
  override unset(): Promise<void> { return Promise.reject(new Error('unused')) }
  override readRecord(): Promise<CredentialRecord | undefined> { return Promise.reject(new Error('unused')) }
  override describeRecord(): Promise<never> { return Promise.reject(new Error('unused')) }
  override listRecords(): Promise<never> { return Promise.reject(new Error('unused')) }
  override modifyRecord(): Promise<never> { return Promise.reject(new Error('unused')) }
  override deleteRecord(_key: CredentialKey): Promise<void> { return Promise.reject(new Error('unused')) }
}

/** What a scripted transport should do for the next request. */
export type FetchScript = (input: string, init?: RequestInit) => Promise<Response> | Response

/**
 * The provider with its transport replaced. `createClient` is the seam for
 * this — a `fetch` field on `Config` would be a test hook masquerading as a
 * deployment choice.
 */
export class ScriptedJev extends TypeSafeJev {
  /** Every request body the transport was handed, parsed. */
  readonly sent: unknown[] = []

  private script: FetchScript = () => json({ model: 'jev-1.13.0', answers: {}, usage: {} })

  /** Replace what the transport does next. */
  setScript(script: FetchScript): void {
    this.script = script
  }

  protected override createClient(apiKey: string): TypeSafeClient {
    return new TypeSafeClient({
      apiKey,
      baseURL: 'https://api.example.invalid',
      defaultModel: 'jev-1.13.0',
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: async (input, init) => {
        if (typeof init?.body === 'string') this.sent.push(JSON.parse(init.body))
        return await this.script(input, init)
      },
    })
  }
}

/** A JSON response, the shape the API answers with. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The provider with its real transport intact, exposing the client factory so a
 * spec can prove what it builds without opening a socket.
 */
export class RealClientJev extends TypeSafeJev {
  /** Build the client the deployment would actually use. */
  build(apiKey: string): TypeSafeClient {
    return this.createClient(apiKey)
  }
}
