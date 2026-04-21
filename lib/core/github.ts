import { type KeyObject, createSign } from 'node:crypto'
import type { OID } from './git.ts'
import { debuglog, jsonify } from '../util/util.ts'

const debug = debuglog('github') // NODE_DEBUG=github

/** A GitHub token. */
export type GitHubToken = string & { __token: true }
export type GitHubAppJwt = GitHubToken & { __token_appjwt: true }
export type GitHubInstallationToken = GitHubToken & { __token_installation: true }

/** The GitHub REST API base URL. */
export type GitHubApiUrl = string & { __ghapi: true }

/** The GitHub GraphQL API base URL. */
export type GitHubGraphqlUrl = string & { __ghgqlapi: true }

export const DefaultGitHubApi = 'https://api.github.com' as GitHubApiUrl
export const DefaultGitHubGraphql = 'https://api.github.com/graphql' as GitHubGraphqlUrl

let globalUserAgent = ''

/** Sets the user agent used for requests. */
export function setUserAgent(ua: string): void {
  globalUserAgent = ua
}

interface TokenProps {
  maxRetries: number,
  userAgent: string,
}

type TokenProp = keyof TokenProps
type TokenWithProp<T extends TokenProp> = GitHubToken & { [K in T]: TokenProps[T] }

/** Returns a copy of token with retries enabled. */
export function withRetries(token: GitHubToken, maxRetries = 3): GitHubToken {
  return withTokenProp(token, 'maxRetries', maxRetries)
}

/** Returns a copy of token with the user agent overridden. */
export function withUserAgent(token: GitHubToken, userAgent: string): GitHubToken {
  return withTokenProp(token, 'userAgent', userAgent)
}

/** Creates a signed GitHub App JWT. */
export function appJwt(appId: number, rsaKey: KeyObject): GitHubAppJwt {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
  })).toString('base64url')

  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 60,
    iss: String(appId),
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(rsaKey, 'base64url')

  return `${header}.${payload}.${signature}` as GitHubAppJwt
}

/** Get the GitHub App installation ID for repo. */
export async function getRepoInstallation(gh: GitHubApiUrl, jwt: GitHubAppJwt, repo: string): Promise<number> {
  const [resp, text] = await request(gh, jwt, 'GET', `repos/${repo}/installation`)
  if (resp.status !== 200) {
    throw new Error(jsonify`Response status ${resp.status} (body: ${text})`)
  }
  const obj = JSON.parse(text) as {
    id: number,
  }
  if (typeof obj?.id !== 'number') {
    throw new Error(jsonify`Response missing installation id`)
  }
  return obj.id
}

/** Create a GitHub App installation token for installId with contents:write permission on repo. */
export async function createInstallationToken(gh: GitHubApiUrl, jwt: GitHubAppJwt, repo: string, installId: number): Promise<GitHubInstallationToken> {
  const [resp, text] = await request(gh, jwt, 'POST', `app/installations/${installId}/access_tokens`, {
    repositories: [repo.replace(/^.+[/]/, '')],
    permissions: {
      contents: 'write',
    },
  })
  if (resp.status !== 201) {
    throw new Error(jsonify`Response status ${resp.status} (body: ${text})`)
  }
  const obj = JSON.parse(text) as {
    token: string,
    permissions: {
      contents: string,
    },
  }
  if (typeof obj?.token !== 'string') {
    throw new Error(jsonify`Response missing token`)
  }
  if (obj?.permissions?.contents !== 'write') {
    throw new Error('Installation does not have contents:write access')
  }
  return obj.token as GitHubInstallationToken
}

/** Revoke a GitHub App installation token. */
export async function revokeInstallationToken(gh: GitHubApiUrl, token: GitHubInstallationToken): Promise<void> {
  const [resp, text] = await request(gh, token, 'DELETE', 'installation/token')
  if (resp.status !== 204) {
    throw new Error(jsonify`Response status ${resp.status} (body: ${text})`)
  }
}

/** Make a GitHub REST API request. */
async function request(gh: GitHubApiUrl, token: GitHubToken, method: string, path: string, body?: any): Promise<[Response, string]> {
  const url = new URL(gh)
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  url.pathname += path

  const headers = new Headers({
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  })
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(body)
  }

  try {
    return await fetchRetry(token, url, {
      method,
      headers,
      body,
    })
  } catch (err) {
    throw new Error(`${method} ${url}: ${err}`)
  }
}

export type GitObjectID = OID

export type Base64String = string & { __base64: true }

export interface CreateCommitOnBranchInput {
  branch: CommittableBranch
  expectedHeadOid: GitObjectID
  message: CommitMessage
  fileChanges: FileChanges
}

export interface CommittableBranch {
  repositoryNameWithOwner: string
  branchName: string
}

export interface CommitMessage {
  headline: string
  body: string
}

export interface FileChanges {
  additions: FileAddition[]
  deletions: FileDeletion[]
}

export interface FileAddition {
  contents: Base64String
  path: string
}

export interface FileDeletion {
  path: string
}

export function encodeBase64(buf: Buffer): Base64String {
  return buf.toString('base64') as Base64String
}

const commitThrottle = throttle(1000) // according to the GitHub recommendations for throttling content-generating requests

/** Create a commit using the GitHub GraphQL API. */
export async function createCommitOnBranch(gh: GitHubGraphqlUrl, token: GitHubToken, input: CreateCommitOnBranchInput): Promise<GitObjectID> {
  const url = new URL(gh)
  const method = 'POST'
  const headers = new Headers({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  })
  const body = JSON.stringify({
    query: `
      mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit {
            oid
          }
        }
      }
    `,
    variables: {
      input,
    },
  })

  await commitThrottle()

  const [resp, text] = await fetchRetry(token, url, {
    method,
    headers,
    body,
  })

  const mt = resp.headers.get('Content-Type') ?? ''
  if (!mt.startsWith('application/json')) {
    if (resp.status !== 200) {
      throw new Error(jsonify`Response status ${resp.status} (body: ${text})`)
    }
    throw new Error(jsonify`Incorrect response type ${mt}`)
  }

  const obj = JSON.parse(text) as {
    errors?: {
      type: string,
      message: string,
    }[],
    data?: {
      createCommitOnBranch: {
        commit: {
          oid: GitObjectID,
        },
      },
    },
  }

  if (obj?.errors?.length) {
    for (const err of obj.errors) {
      if (err?.message?.includes('No commit exists with specified expectedHeadOid')) {
        throw new Error(`Remote branch head is behind local parent commit: ${err.type}: ${err.message}`)
      }
      if (err?.message?.includes('Expected branch to point to')) {
        throw new Error(`Local parent commit is behind remote branch head: ${err.type}: ${err.message}`)
      }
    }
    const msg = obj.errors.map(e => `\t${e.type}: ${e.message}`).join('\n')
    throw new Error(`GitHub GraphQL mutation failed:\n${msg}`)
  }
  if (!obj?.data?.createCommitOnBranch?.commit?.oid) {
    throw new Error(jsonify`GitHub created the commit but didn't return the oid`)
  }
  return obj?.data?.createCommitOnBranch?.commit?.oid
}

export interface RetryOptions {
  maxRetries?: number,
}

let retryLog: ((msg: string) => void) | undefined

export function setRetryLog(fn: (msg: string) => void): void {
  retryLog = fn
}

/**
 * Like fetch, but retries GitHub API requests using similar logic to
 * @octokit/plugin-throttling and @octokit/plugin-retry.
 */
export async function fetchRetry(token: GitHubToken, url: URL, init: RequestInit): Promise<[Response, string]> {
  const maxRetries = tokenProp(token, 'maxRetries') ?? 3 // like @octokit/plugin-retry
  const userAgent = tokenProp(token, 'userAgent') ?? globalUserAgent
  const doNotRetry = new Set([400, 401, 403, 404, 410, 422, 451]) // like @octokit/plugin-retry

  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (userAgent) {
    headers.set('User-Agent', userAgent)
  }
  init = {...init, headers}

  for (let attempt = 1; ; attempt++) {
    const prefix = `${init.method ?? 'GET'} ${url} (attempt ${attempt})`
    debug(prefix)
    let resp: Response | undefined
    let isRetryable = false
    let isSecondaryRateLimit = false
    try {
      resp = await fetch(url, init)
      const text = await resp.text()

      if (resp) {
        debug(`${prefix}: status=${resp.status} ${Array.from(resp.headers.entries()).filter(([name]) => name.toLowerCase().startsWith('x-ratelimit-')).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(' ')}`)
      }

      if (resp.status >= 400) {
        if (text.includes('secondary rate')) { // like @octokit/plugin-throttling
          isRetryable = true
          isSecondaryRateLimit = true
          throw new Error(jsonify`hit secondary rate limit (body: ${text})`)
        }
        if (!doNotRetry.has(resp.status)) { // like @octokit/plugin-retry
          isRetryable = true
        }
        if (resp.headers.get('x-ratelimit-remaining') == '0' && (resp.status == 403 || resp.status == 429)) {
          throw new Error(jsonify`hit rate limit (body: ${text})`)
        }
        throw new Error((isRetryable ? `` : `non-retryable `) + jsonify`reponse status ${resp.status} (body: ${text})`)
      }

      return [resp, text] as const
    } catch (err) {
      debug(`${prefix}: failed (isRetryable=${isRetryable} isSecondaryRateLimit=${isSecondaryRateLimit}): ${err}`)

      if (!isRetryable || attempt > maxRetries) {
        throw new Error(`${prefix}: ${err instanceof Error ? err.message : err}`)
      }

      const retryAfter = resp?.headers.get('Retry-After')
      if (retryAfter) {
        let delay = (/^\d+$/.test(retryAfter)
          ? Math.max(0, parseInt(retryAfter, 10) * 1000)
          : Math.max(0, new Date(retryAfter).getTime() - Date.now()) + 1000)
        retryLog?.(`${prefix}: retrying failed (${err}) request after ${delay}ms (retry-after)`)
        debug(`${prefix}: retrying in ${delay}ms (retry-after)`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      const rateLimitReset = resp?.headers.get('x-ratelimit-reset')
      if (rateLimitReset) {
        const delay = Math.max(0, parseInt(rateLimitReset) * 1000 - Date.now())
        retryLog?.(`${prefix}: retrying failed (${err}) request after ${delay}ms (x-ratelimit-reset)`)
        debug(`${prefix}: retrying in ${delay}ms (x-ratelimit-reset)`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      const delay = isSecondaryRateLimit ? 60000 : (attempt ** 2) * 1000
      retryLog?.(`${prefix}: retrying failed (${err}) request after ${delay}ms`)
      debug(`${prefix}: retrying in ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }
  }
}

/**
 * Returns a promise which resolves at most once every interval.
 */
function throttle(interval: number): () => Promise<void> {
  let last: number | undefined
  return async () => {
    if (last) {
      const elapsed = Date.now() - last
      if (elapsed < interval) {
        await new Promise(resolve => setTimeout(resolve, interval - elapsed))
      }
    }
    last = Date.now()
  }
}

const symbols = {
  maxRetries: Symbol('maxRetries'),
  userAgent: Symbol('userAgent')
} as const satisfies { [K in keyof TokenProps]: symbol}

function withTokenProp<T extends GitHubToken, U extends TokenProp>(token: T, key: U, val: TokenProps[U]): TokenWithProp<U> {
  const tmp = new String(token)
  const sym = symbols[key]
  if (!sym) {
    throw new TypeError(jsonify`Unknown prop ${key}`)
  }
  for (const x of Object.values(symbols)) {
    if (Object.hasOwn(token, x) && x !== sym) {
      Object.defineProperty(tmp, x, {
        value: (token as any)[x],
        configurable: false,
        enumerable: false,
      })
    }
  }
  Object.defineProperty(tmp, sym, {
    value: val,
    configurable: false,
    enumerable: false,
  })
  return tmp as any
}

function tokenProp<T extends GitHubToken, U extends TokenProp>(token: T, key: U): T extends TokenWithProp<U> ? TokenProps[U] : TokenProps[U] | undefined {
  const sym = symbols[key]
  if (Object.hasOwn(token, sym)) {
    return (token as any)[sym] as TokenProps[U]
  }
  return undefined as any
}

export const __test = {
  withTokenProp,
  tokenProp,
}
