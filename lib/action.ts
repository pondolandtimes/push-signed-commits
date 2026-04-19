import { env, exit, stderr, stdout } from 'node:process'
import { Console } from 'node:console'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { type KeyObject, randomUUID } from 'node:crypto'
import { EOL } from 'node:os'
import {
  type GitHubToken,
  type GitHubApiUrl, DefaultGitHubApi,
  type GitHubGraphqlUrl, DefaultGitHubGraphql,
} from './github.ts'
import {
  type Output, main,
  parsePrivateKey, validateBaseUrl,
} from './main.ts'

export class ActionInputError extends Error {
  readonly key: string

  constructor(key: string, message: string) {
    super(`Input ${key}: ${message}`)
    this.name = 'ActionInputError'
    this.key = key
  }
}

export function inputs(): Parameters<typeof main>[0] {
  try {
    return {
      path: getInput('path') || '.',
      repository: getInput('repository'),
      branch: getInput('branch'),
      revision: getInput('revision') || null,
      allowEmpty: getBoolInput('allow-empty') ?? false,
      commitMessage: getInput('commit-message'),
      commitMessageFile: getFileInput('commit-message-file') ?? null,
      userAgent: getInput('user-agent'),
      insecure: getBoolInput('insecure') ?? false,
      dryRun: getBoolInput('dry-run') ?? false,
      githubToken: getInput('github-token') as GitHubToken,
      githubApiUrl: getUrlInput('github-api-url') as GitHubApiUrl || env['GITHUB_API_URL'] as GitHubApiUrl || DefaultGitHubApi,
      githubGraphqlUrl: getUrlInput('github-graphql-url') as GitHubGraphqlUrl || env['GITHUB_GRAPHQL_URL'] as GitHubGraphqlUrl || DefaultGitHubGraphql,
      appId: getIntegerInput('app-id') ?? 0,
      appKey: getKeyInput('app-key') ?? null,
      git: getInput('git-binary') || 'git',
    }
  } catch (err) {
    if (err instanceof ActionInputError) {
      stderr.write(`error: ${err.message}${EOL}`)
      exit(2)
    }
    throw err
  }
}

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

if (import.meta.main) {
  globalThis.console = new Console({
    stdout: stderr,
    stderr: stderr,
    colorMode: true,
  })
  exit(await main(inputs(), outputs))
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
    const v = Number(str)
    if (!Number.isInteger(v)) {
      throw new ActionInputError(name, `Invalid integer ${JSON.stringify(str)}`)
    }
    return v
  }
  return
}

// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands

// actions/core@v3.0.0/src/core.ts, but simpler
function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  return env[key]?.trim() ?? ''
}

// actions/core@v3.0.0/src/core.ts, but simpler
function setOutput(name: string, value: string): void {
  if (!issueFileCommand('OUTPUT', name, value)) {
    stdout.write(EOL)
    issueCommand("set-output", { name }, value)
  }
}

// actions/core@v3.0.0/src/command.ts, but simpler
function issueCommand(command: string, properties: {[key: string]: any}, message: string): void {
  let props = ''
  if (properties) {
    for (const [key, val] of Object.entries(properties)) {
      if (val) {
        if (props) {
          props += ','
        } else {
          props += ' '
        }
        props += `${key}=${val.toString().replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll(':', '%3A').replaceAll(',', '%2C')}`
      }
    }
  }
  stdout.write(`::${command}${props}::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}${EOL}`)
}

// actions/core@v3.0.0/src/file-command.ts, but simpler
function issueFileCommand(command: string, key: string, value: string): boolean {
  const path = env[`GITHUB_${command}`]
  if (path) {
    if (!existsSync(path)) {
      throw new Error(`Missing ${command} command file ${path}`)
    }
    const delim = `ghadelimiter_${randomUUID()}`
    if (key.includes(delim) || value.includes(delim)) {
      throw new Error(`Key/value includes random delimiter ${delim}`)
    }
    appendFileSync(path, `${key}<<${delim}${EOL}${value}${EOL}${delim}${EOL}`, { encoding: 'utf8' })
    return true
  }
  return false
}
