#!/usr/bin/env node
import { Console } from 'node:console'
import { EOL } from 'node:os'
import { styleText } from 'node:util'
import {
  type GitHubToken,
  type GitHubApiUrl, DefaultGitHubApi,
  type GitHubGraphqlUrl, DefaultGitHubGraphql,
  setRetryLog,
} from '../core/github.ts'
import { OptionError, parseOptions, help } from '../util/options.ts'
import {
  type Input, main as main_,
  parseInteger, parsePrivateKey, validateBaseUrl,
} from './main.ts'
import { hookDebugLog, makeUserAgent } from '../util/util.ts'

/** Invalid positional arguments. */
export class ArgumentError extends Error {
  readonly help: boolean
  constructor(help: boolean) {
    super('Invalid argument')
    this.name = 'ArgumentError'
    this.help = help
  }
}

/** CLI entry point. */
export async function main(opts: {
  cmd: string,
  env: NodeJS.ProcessEnv,
  argv: string[],
  stderr: NodeJS.WriteStream,
}): Promise<number> {
  let opt
  try {
    opt = inputs(opts.env, opts.argv)
  } catch (err) {
    if (err instanceof OptionError) {
      opts.stderr.write(`error: ${err.message}${EOL}`)
      return 2
    }
    if (err instanceof ArgumentError) {
      opts.stderr.write(usage(opts.cmd, EOL).replaceAll('\n', EOL) + EOL)
      return err.help ? 0 : 2
    }
    throw err
  }
  const console = new Console({
    stdout: opts.stderr,
    stderr: opts.stderr,
    colorMode: 'auto',
  })
  const log = (msg?: string) => msg ? console.log(msg) : console.log()
  if (opt.verbose) {
    hookDebugLog((section, msg) => {
      log(styleText(['magenta', 'dim'], `[${section}] ${msg}`))
    })
  }
  setRetryLog(msg => log(styleText(['dim', 'yellow'], msg)))
  return await main_(log, opt)
}

const spec = {
  allowEmpty: { type: 'bool', long: 'allow-empty', help: 'create en empty commit even if there are no changes' }, // matches git-commit
  commitMessage: { type: 'str', kind: 'message', short: 'm', long: 'message', help: 'commit message to use if creating a new commit from the staging area' }, // matches git-commit
  commitMessageFile: { type: 'str', kind: 'path', short: 'F', long: 'file', help: 'read the commit message from the specified (overrides --message)', parse: p => p || null }, // matches git-commit
  userAgent: { type: 'str', short: 'A', long: 'user-agent', default: makeUserAgent(), help: 'override the user agent for GitHub API requests' }, // matches curl
  insecure: { type: 'bool', short: 'k', long: 'insecure', help: 'do not validate check tls certificates for GitHub API requests' }, // matches curl
  dryRun: { type: 'bool', short: 'n', long: 'dry-run', help: 'do not actually push commits, just print the mutations' }, // matches most tools
  githubToken: { type: 'str', kind: 'token', long: 'github-token', env: 'GITHUB_TOKEN', help: 'github token with contents:write permission', parse: t => t ? t as GitHubToken : null }, // env is standard
  githubApiUrl: { type: 'str', kind: 'url', long: 'github-api-url', env: 'GITHUB_API_URL', help: 'github api url', default: DefaultGitHubApi, parse: u => (validateBaseUrl(u), u as GitHubApiUrl) }, // env is standard
  githubGraphqlUrl: { type: 'str', kind: 'url', long: 'github-grqphql-url', env: 'GITHUB_GRAPHQL_URL', help: 'github graphql api url', default: DefaultGitHubGraphql, parse: u => (validateBaseUrl(u), u as GitHubGraphqlUrl) }, // env is standard
  appId: { type: 'str', kind: 'id', long: 'app', help: 'authenticate as a github app with the specified id (overrides --github-token)', parse: n => n ? parseInteger(n) : null },
  appKey: { type: 'str', kind: 'pem', long: 'app-key', env: 'APP_PRIVATE_KEY', help: 'the private key to use if authenticating as a github app (can be base64-encoded or contain escaped newlines)', parse: s => s ? parsePrivateKey(s) : null },
  git: { type: 'str', kind: 'cmd', long: 'git', help: 'the git executable to use', default: 'git' },
  help: { type: 'bool', short: 'h', long: 'help', help: 'show this help text' },
  verbose: { type: 'bool', short: 'v', long: 'verbose', help: `show debug output` },
  path: { type: 'str', kind: 'path', short: 'C', help: 'repository path', default: '.' }, // matches git-commit, most tools
} as const satisfies Parameters<typeof parseOptions>[0]

/** Get the help text. */
export function usage(cmd: string, eol: string = '\n'): string {
  return [
    `usage: ${cmd} [options] username/repository target_branch [revision]`,
    ``,
    help(spec, eol),
    ``,
    `revision is a commit or range of commits (see man gitrevisions(7))`,
    `if not specified, a commit is created from the staging area`,
  ].join(eol)
}

/**
 * Parse the arguments, throwing an {@link OptionError} or
 * {@link ArgumentError} if invalid.
 */
export function inputs(env: NodeJS.ProcessEnv, argv: string[]): Input & {
  verbose: boolean,
} {
  const {opts, args} = parseOptions(spec, argv, env)
  if (opts.help || args.length < 2 || args.length > 3) {
    throw new ArgumentError(opts.help)
  }
  const pos = {
    repository: args[0],
    branch: args[1],
    revision: args.length > 2 ? args[2] : null,
  }
  return {...opts, ...pos}
}

if (import.meta.main) {
  process.exit(await main({
    cmd: process.argv0.startsWith('node') ? process.argv.slice(0, 2).join(' ') : process.argv0,
    env: process.env,
    argv: process.argv.slice(2),
    stderr: process.stderr,
  }))
}
