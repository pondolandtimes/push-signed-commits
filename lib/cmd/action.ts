#!/usr/bin/env node
import { Console } from 'node:console'
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { EOL } from 'node:os'
import { styleText } from 'node:util'
import {
  type GitHubToken,
  type GitHubApiUrl, DefaultGitHubApi,
  type GitHubGraphqlUrl, DefaultGitHubGraphql,
  setRetryLog,
} from '../core/github.ts'
import { debug, getInput, setOutput } from '../util/gha.ts'
import {
  type Input, type Output, main as main_,
  parseInteger,
  parsePrivateKey, validateBaseUrl,
} from './main.ts'
import { hookDebugLog, makeUserAgent } from '../util/util.ts'

/** Invalid input. */
export class ActionInputError extends Error {
  readonly key: string

  constructor(key: string, message: string) {
    super(`Input ${key}: ${message}`)
    this.name = 'ActionInputError'
    this.key = key
  }
}

/** GitHub Actions point. */
export async function main(opts: {
  env: NodeJS.ProcessEnv,
  stderr: NodeJS.WriteStream,
}): Promise<number> {
  try {
    const console = new Console({
      stdout: opts.stderr,
      stderr: opts.stderr,
      colorMode: 'auto',
    })
    const log = (msg?: string) => msg ? console.log(msg) : console.log()
    setRetryLog(msg => log(styleText(['dim', 'yellow'], msg)))
    hookDebugLog(msg => {
      debug(msg) // secret ACTIONS_STEP_DEBUG
      return msg
    })
    return await main_(log, inputs(opts.env), outputs)
  } catch (err) {
    if (err instanceof ActionInputError) {
      opts.stderr.write(`error: ${err.message}${EOL}`)
      return 2
    }
    throw err
  }
}

/** Parse the inputs, throwing an {@link ActionInputError} if invalid. */
export function inputs(env: NodeJS.ProcessEnv): Input {
  return {
    path: getInput('path') || '.',
    repository: getInput('repository'),
    branch: getInput('branch'),
    revision: getInput('revision') || null,
    allowEmpty: getBoolInput('allow-empty') ?? false,
    commitMessage: getInput('commit-message'),
    commitMessageFile: getFileInput('commit-message-file') ?? null,
    userAgent: getInput('user-agent') || makeUserAgent(),
    insecure: getBoolInput('insecure') ?? false,
    dryRun: getBoolInput('dry-run') ?? false,
    githubToken: getInput('github-token') as GitHubToken,
    githubApiUrl: getUrlInput('github-api-url') as GitHubApiUrl || env['GITHUB_API_URL'] as GitHubApiUrl || DefaultGitHubApi,
    githubGraphqlUrl: getUrlInput('github-graphql-url') as GitHubGraphqlUrl || env['GITHUB_GRAPHQL_URL'] as GitHubGraphqlUrl || DefaultGitHubGraphql,
    appId: getIntegerInput('app-id') ?? null,
    appKey: getKeyInput('app-key') ?? null,
    git: getInput('git-binary') || 'git',
  }
}

/** Write the outputs. */
export function outputs(out: Output): void {
  setOutput('not-pushable', JSON.stringify(out.notPushable))
  if (out.remoteOIDs != undefined) {
    setOutput('pushed-oids', out.remoteOIDs.join(' '))
    setOutput('pushed-oid', out.remoteOIDs.length >= 1 ? out.remoteOIDs[out.remoteOIDs.length-1] : '')
  }
  if (out.localOIDs != undefined) {
    setOutput('local-commit-oids', out.localOIDs.join(' '))
    setOutput('local-commit-oid', out.localOIDs.length >= 1 ? out.localOIDs[out.localOIDs.length-1] : '')
  }
}

function getKeyInput(name: string): KeyObject | undefined {
  const str = getInput(name)
  if (str !== '') {
    try {
      return parsePrivateKey(str)
    } catch (err) {
      throw new ActionInputError(name, `Parse private key: ${err instanceof Error ? err.message : err}`)
    }
  }
  return
}

function getUrlInput(name: string): string | undefined {
  const str = getInput(name)
  if (str !== '') {
    try {
      validateBaseUrl(str)
    } catch (err) {
      throw new ActionInputError(name, `${err instanceof Error ? err.message : err}`)
    }
  }
  return
}

function getFileInput(name: string): string | undefined {
  const str = getInput(name)
  if (str !== '') {
    try {
      return readFileSync(str, { encoding: 'utf-8' })
    } catch (err) {
      throw new ActionInputError(name, `Read file ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return
}

function getBoolInput(name: string): boolean | undefined {
  const str = getInput(name)
  if (str !== '') {
    switch (str) {
      case '1': case 't': case 'T': case 'true': case 'TRUE': case 'True':
        return true
      case '0': case 'f': case 'F': case 'false': case 'FALSE': case 'False':
        return false
    }
    throw new ActionInputError(name, `Invalid bool ${JSON.stringify(str)}`)
  }
  return
}

function getIntegerInput(name: string): number | undefined {
  const str = getInput(name)
  if (str !== '') {
    try {
      return parseInteger(str)
    } catch (err) {
      throw new ActionInputError(name, `${err instanceof Error ? err.message : err}`)
    }
  }
  return
}

if (import.meta.main) {
  process.exit(await main({
    env: process.env,
    stderr: process.stderr,
  }))
}
