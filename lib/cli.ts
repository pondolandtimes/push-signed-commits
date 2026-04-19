#!/usr/bin/env node
import { exit, stderr } from 'node:process'
import { Console } from 'node:console'
import { EOL } from 'node:os'
import { type Options, OptionError, parseOptions, help } from './options.ts'
import {
    type GitHubToken,
    type GitHubApiUrl, DefaultGitHubApi,
    type GitHubGraphqlUrl, DefaultGitHubGraphql,
} from './github.ts'
import { main, parseInteger, parsePrivateKey, validateBaseUrl } from './main.ts'

export const options = {
  allowEmpty: { type: 'bool', long: 'allow-empty', help: 'create en empty commit even if there are no changes' }, // matches git-commit
  commitMessage: { type: 'str', kind: 'message', short: 'm', long: 'message', help: 'commit message to use if creating a new commit from the staging area' }, // matches git-commit
  commitMessageFile: { type: 'str', kind: 'path', short: 'F', long: 'file', help: 'read the commit message from the specified (overrides --message)', parse: p => p || null }, // matches git-commit
  userAgent: { type: 'str', short: 'A', long: 'user-agent', help: 'override the user agent for GitHub API requests' }, // matches curl
  insecure: { type: 'bool', short: 'k', long: 'insecure', help: 'do not validate check tls certificates for GitHub API requests' }, // matches curl
  dryRun: { type: 'bool', short: 'n', long: 'dry-run', help: 'do not actually push commits, just print the mutations' }, // matches most tools
  githubToken: { type: 'str', kind: 'token', long: 'github-token', env: 'GITHUB_TOKEN', help: 'github token with contents:write permission', parse: t => t ? t as GitHubToken : null }, // env is standard
  githubApiUrl: { type: 'str', kind: 'url', long: 'github-api-url', env: 'GITHUB_API_URL', help: 'github api url', default: DefaultGitHubApi, parse: u => (validateBaseUrl(u), u as GitHubApiUrl) }, // env is standard
  githubGraphqlUrl: { type: 'str', kind: 'url', long: 'github-grqphql-url', env: 'GITHUB_GRAPHQL_URL', help: 'github graphql api url', default: DefaultGitHubGraphql, parse: u => (validateBaseUrl(u), u as GitHubGraphqlUrl) }, // env is standard
  appId: { type: 'str', kind: 'id', long: 'app', help: 'authenticate as a github app with the specified id (overrides --github-token)', parse: n => n ? parseInteger(n) : null },
  appKey: { type: 'str', kind: 'pem', long: 'app-key', help: 'the private key to use if authenticating as a github app (can be base64-encoded or contain escaped newlines)', parse: s => s ? parsePrivateKey(s) : null },
  git: { type: 'str', kind: 'cmd', long: 'git', help: 'the git executable to use', default: 'git' },
  help: { type: 'bool', short: 'h', long: 'help', help: 'show this help text' },
  path: { type: 'str', kind: 'path', short: 'C', help: 'repository path', default: '.' }, // matches git-commit, most tools
} as const satisfies Options

export function usage(cmd: string = 'push-signed-commits'): string {
  return [
    `usage: ${cmd} [options] username/repository target_branch [revision]`,
    ``,
    help(options),
    ``,
    `revision is a commit or range of commits (see man gitrevisions(7))`,
    `if not specified, a commit is created from the staging area`,
  ].join('\n')
}

export function parse() {
  let opts, args
  try {
    ({opts, args} = parseOptions(options))
  } catch (err) {
    if (err instanceof OptionError) {
      stderr.write(`error: ${err.message}${EOL}`)
      exit(2)
    }
    throw err
  }
  if (opts.help || args.length < 2 || args.length > 3) {
    stderr.write(usage().replaceAll('\n', EOL) + EOL)
    exit(opts.help || !args.length ? 0 : 2)
  }
  const repository = args[0]
  const branch = args[1]
  const revision = args.length > 2 ? args[2] : null
  return {...opts, repository, branch, revision}
}

if (import.meta.main) {
  globalThis.console = new Console({
    stdout: stderr,
    stderr: stderr,
    colorMode: true,
  })
  exit(await main(parse()))
}
