import { type KeyObject, createSign } from 'node:crypto'
import type { OID } from './git.ts'
import { debuglog, jsonify } from '../util/util.ts'

const debug = debuglog('github') // NODE_DEBUG=github

/** A GitHub token. */
export type GitHubToken = string & { __token: true }

/** The GitHub REST API base URL. */
export type GitHubApiUrl = string & { __ghapi: true }

/** The GitHub GraphQL API base URL. */
export type GitHubGraphqlUrl = string & { __ghgqlapi: true }

export const DefaultGitHubApi = 'https://api.github.com' as GitHubApiUrl
export const DefaultGitHubGraphql = 'https://api.github.com/graphql' as GitHubGraphqlUrl

let userAgent = ''

/** Sets the user agent used for requests. */
export function setUserAgent(ua: string): void {
  userAgent = ua
}

/** Creates a signed GitHub App JWT. */
export function appJwt(appId: number, rsaKey: KeyObject): GitHubToken {
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

  return `${header}.${payload}.${signature}` as GitHubToken
}

/** Get the GitHub App installation ID for repo. */
export async function getRepoInstallation(gh: GitHubApiUrl, jwt: GitHubToken, repo: string): Promise<number> {
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
export async function createInstallationToken(gh: GitHubApiUrl, jwt: GitHubToken, repo: string, installId: number): Promise<GitHubToken> {
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
  return obj.token as GitHubToken
}

/** Revoke a GitHub App installation token. */
export async function revokeInstallationToken(gh: GitHubApiUrl, token: GitHubToken): Promise<void> {
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
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
  })
  if (userAgent) {
    headers.set('User-Agent', userAgent)
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(body)
  }

  try {
    return await fetchRetry(url, {
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
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  })
  if (userAgent) {
    headers.set('User-Agent', userAgent)
  }
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

  const [resp, text] = await fetchRetry(url, {
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
export async function fetchRetry(url: URL, init: RequestInit, opt?: RetryOptions): Promise<[Response, string]> {
  const maxRetries = opt?.maxRetries ?? 3 // like @octokit/plugin-retry
  const doNotRetry = new Set([400, 401, 403, 404, 410, 422, 451]) // like @octokit/plugin-retry

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
