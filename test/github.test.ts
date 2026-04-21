import { strictEqual, ok, rejects, equal } from 'node:assert'
import { describe, it, mock } from 'node:test'
import * as github from '../lib/core/github.ts'

describe('tokenProp', () => {
  it('withTokenProp is pure', () => {
    const tok = 'dummy' as github.GitHubToken
    const tok2 = github.__test.withTokenProp(tok, 'maxRetries', 3)
    equal(tok, 'dummy')
    equal(tok2, 'dummy')
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), undefined, 'original token is unchanged')
    strictEqual(github.__test.tokenProp(tok2, 'maxRetries'), 3)
  })
  it('withTokenProp can redefine props', () => {
    const tok = github.__test.withTokenProp('dummy' as github.GitHubToken, 'maxRetries', 3)
    const tok2 = github.__test.withTokenProp(tok, 'maxRetries', 0)
    equal(tok, 'dummy')
    equal(tok2, 'dummy')
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), 3)
    strictEqual(github.__test.tokenProp(tok2, 'maxRetries'), 0)
  })
  it('tokenProp returns undefined if the prop is not set', () => {
    const tok = 'dummy' as github.GitHubToken
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), undefined)
  })
  it(`tokenProp returns the value if set`, () => {
    const tok = github.__test.withTokenProp('dummy' as github.GitHubToken, 'maxRetries', 3)
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), 3)
  })
  it('multiple props can be set', () => {
    let tok = 'dummy' as github.GitHubToken
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), undefined)
    strictEqual(github.__test.tokenProp(tok, 'userAgent'), undefined)
    tok = github.__test.withTokenProp(tok, 'maxRetries', 1)
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), 1)
    strictEqual(github.__test.tokenProp(tok, 'userAgent'), undefined)
    tok = github.__test.withTokenProp(tok, 'userAgent', 'test')
    strictEqual(github.__test.tokenProp(tok, 'maxRetries'), 1)
    strictEqual(github.__test.tokenProp(tok, 'userAgent'), 'test')
  })
})

describe('fetchRetry', () => {
  const tok = 'dummy' as github.GitHubToken
  const url = new URL('https://api.github.test/fake')
  const init: RequestInit = { method: 'GET', headers: new Headers() }

  it('returns response and text on success', async () => {
    using _ = mockFetch(
      { status: 200, body: 'body' },
    )
    const [resp, text] = await github.fetchRetry(tok, url, init)
    strictEqual(resp.status, 200)
    strictEqual(text, 'body')
  })

  for (const status of [400, 401, 403, 404, 410, 422, 451]) {
    it(`throws immediately for non-retryable status ${status}`, async () => {
      using ctx = mockFetch(
        { status, body: 'error' },
      )
      await rejects(github.fetchRetry(github.withRetries(tok, 3), url, init), /non-retryable/)
      strictEqual(ctx.fetches.length, 1)
    })
  }

  it('retries retryable status and returns on success', async () => {
    using _ = mockFetch(
      { status: 500, body: 'error' },
      { status: 200, body: 'body' },
    )
    const [resp, text] = await github.fetchRetry(github.withRetries(tok, 3), url, init)
    strictEqual(resp.status, 200)
    strictEqual(text, 'body')
  })

  it('throws after maxRetries', async () => {
    using ctx = mockFetch(
      { status: 500, body: 'error' },
      { status: 500, body: 'error' },
      { status: 500, body: 'error' },
    )
    await rejects(github.fetchRetry(github.withRetries(tok, 2), url, init), /reponse status 500/)
    strictEqual(ctx.fetches.length, 3) // 1 initial + 2 retries
  })

  it('throws after maxRetries 0', async () => {
    using _ = mockFetch(
      { status: 500, body: 'error' },
    )
    await rejects(github.fetchRetry(github.withRetries(tok, 0), url, init), /reponse status 500/)
  })

  it('throws immediately when fetch throws', async () => {
    using ctx = mockFetch(
      new TypeError('fetch failed'),
    )
    await rejects(github.fetchRetry(github.withRetries(tok, 3), url, init), /fetch failed/)
    strictEqual(ctx.fetches.length, 1)
  })

  it('retries secondary rate limit without Retry-After with 60s delay', async () => {
    using ctx = mockFetch(
      { status: 429, body: 'secondary rate limit' },
      { status: 200, body: 'ok' },
    )
    const [resp] = await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(resp.status, 200)
    strictEqual(ctx.timeouts[0], 60000)
  })

  it('retries secondary rate limit with Retry-After', async () => {
    using ctx = mockFetch(
      { status: 429, body: 'secondary rate limit', headers: { 'Retry-After': '5' } },
      { status: 200, body: 'ok' },
    )
    const [resp] = await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(resp.status, 200)
    strictEqual(ctx.timeouts[0], 5000)
  })

  it('retries secondary rate limit retries regardless of status code', async () => {
    using ctx = mockFetch(
      { status: 403, body: 'secondary rate limit' },
      { status: 200, body: 'ok' },
    )
    const [resp] = await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(resp.status, 200)
    strictEqual(ctx.timeouts[0], 60000)
  })

  it('uses numeric Retry-After', async () => {
    using fn = mockFetch(
      { status: 500, body: 'error', headers: { 'Retry-After': '5' } },
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(fn.timeouts[0], 5000)
  })

  it('uses date Retry-After', async () => {
    using ctx = mockFetch(
      { status: 500, body: 'error', headers: { 'Retry-After': new Date(Date.now() + 3000).toUTCString() } },
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withRetries(tok, 1), url, init)
    ok(ctx.timeouts[0] >= 3000 && ctx.timeouts[0] <= 5000, `expected ~4000ms delay, got ${ctx.timeouts[0]}ms`)
  })

  it('uses x-ratelimit-reset header', async () => {
    using ctx = mockFetch(
      { status: 500, body: 'error', headers: { 'x-ratelimit-reset': `${Math.floor((Date.now() + 5000) / 1000)}` } },
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withRetries(tok, 1), url, init)
    ok(ctx.timeouts[0] >= 3000 && ctx.timeouts[0] <= 6000, `expected ~5000ms delay, got ${ctx.timeouts[0]}`)
  })

  it('prefers Retry-After over x-ratelimit-reset header', async () => {
    using ctx = mockFetch(
      { status: 500, body: 'error', headers: { 'Retry-After': '1', 'x-ratelimit-reset': `${Math.floor((Date.now() + 5000) / 1000)}` } },
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(ctx.timeouts[0], 1000)
  })

  it('throws immediately on rate limit for non-retryable status 403', async () => {
    using ctx = mockFetch(
      { status: 403, body: 'rate limited', headers: { 'x-ratelimit-remaining': '0' } },
    )
    await rejects(github.fetchRetry(github.withRetries(tok, 3), url, init), /hit rate limit/)
    strictEqual(ctx.fetches.length, 1)
  })

  it('retries on rate limit for retryable status 429', async () => {
    using _ = mockFetch(
      { status: 429, body: 'rate limited', headers: { 'x-ratelimit-remaining': '0' } },
      { status: 200, body: 'ok' },
    )
    const [resp] = await github.fetchRetry(github.withRetries(tok, 1), url, init)
    strictEqual(resp.status, 200)
  })

  it('uses exponential backoff when no retry headers are present', async () => {
    using ctx = mockFetch(
      { status: 500, body: 'error' },
      { status: 500, body: 'error' },
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withRetries(tok, 3), url, init)
    strictEqual(ctx.timeouts[0], 1000)
    strictEqual(ctx.timeouts[1], 4000)
  })

  it('sets User-Agent from setUserAgent', async () => {
    github.setUserAgent('test/1')
    using ctx = mockFetch(
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(tok, url, init)
    const headers = ctx.fetches[0]!.arguments[1].headers as Headers
    strictEqual(headers.get('User-Agent'), 'test/1')
  })

  it('overrides User-Agent from withUserAgent', async () => {
    github.setUserAgent('test/1')
    using ctx = mockFetch(
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withUserAgent(tok, 'test/2'), url, init)
    const headers = ctx.fetches[0]!.arguments[1].headers as Headers
    strictEqual(headers.get('User-Agent'), 'test/2')
  })

  it('removes User-Agent with empty withUserAgent', async () => {
    github.setUserAgent('test/1')
    using ctx = mockFetch(
      { status: 200, body: 'ok' },
    )
    await github.fetchRetry(github.withUserAgent(tok, ''), url, init)
    const headers = ctx.fetches[0]!.arguments[1].headers as Headers
    strictEqual(headers.get('User-Agent'), null)
  })
})

function mockFetch(...specs: (Error | { status: number; body: string; headers?: Record<string, string> })[]) {
  const fetch = globalThis.fetch
  if (typeof (fetch as any)['mock'] !== 'undefined') {
    throw new Error('fetch is already mocked')
  }

  const setTimeout = globalThis.setTimeout
  if (typeof (setTimeout as any)['mock'] !== 'undefined') {
    throw new Error('setTimeout is already mocked')
  }

  const mockFetch = mock.fn(async (_url: URL, _init: RequestInit) => {
    const s = specs.shift()
    if (!s) throw new Error('unexpected extra fetch call')
    if (s instanceof Error) throw s
    return new Response(s.body, { status: s.status, headers: s.headers })
  })

  const timeouts: number[] = []
  const mockSetTimeout = mock.fn((callback: () => void, delay = 0) => {
    timeouts.push(delay)
    callback()
    return setTimeout(() => {}, 0)
  })

  globalThis.fetch = mockFetch as unknown as typeof fetch
  globalThis.setTimeout = mockSetTimeout as unknown as typeof setTimeout

  return {
    get timeouts() {
      return timeouts
    },
    get fetches() {
      return mockFetch.mock.calls
    },
    [Symbol.dispose]() {
      globalThis.fetch = fetch
      globalThis.setTimeout = setTimeout
    },
  }
}
