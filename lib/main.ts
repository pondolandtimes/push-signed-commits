import { type KeyObject, createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { env } from 'node:process'
import { styleText } from 'node:util'
import { type CommitOID, repo } from './git.ts'
import { NotPushableError, commits, staged } from './commit.ts'
import {
  type GitHubToken,
  type GitHubApiUrl,
  type GitHubGraphqlUrl, setUserAgent,
  appJwt, getRepoInstallation, createInstallationToken, revokeInstallationToken,
  type CommittableBranch, type CreateCommitOnBranchInput, createCommitOnBranch,
} from './github.ts'

export interface Options {
  path: string,
  repository: string,
  branch: string,
  revision: string | null,
  allowEmpty: boolean,
  commitMessage: string,
  commitMessageFile: string | null,
  userAgent: string,
  insecure: boolean,
  dryRun: boolean,
  githubToken: GitHubToken | null,
  githubApiUrl: GitHubApiUrl,
  githubGraphqlUrl: GitHubGraphqlUrl,
  appId: number | null,
  appKey: KeyObject | null,
  git: string,
}

export interface Output {
  notPushable: boolean,
  remoteOIDs?: CommitOID[], // not set if dry run
  localOIDs?: CommitOID[], // not set if staged
}

export async function main(println: (msg?: string) => void, opts: Options, done?: (out: Output) => void): Promise<number> {
  let revoke = false
  let commitMessage: string
  let token: GitHubToken | undefined
  let localOIDs: CommitOID[] = []
  let remoteOIDs: CommitOID[] = []
  let notPushable = false
  try {
    if (opts.insecure) {
      env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    }
    if (opts.userAgent) {
      setUserAgent(opts.userAgent)
    }

    if (!/.[/]./.test(opts.repository)) {
      throw new Error(`Invalid repository ${JSON.stringify(opts.repository)}: must be in username/repository format`)
    }
    if (!opts.branch) {
      throw new Error(`Invalid branch ${JSON.stringify(opts.branch)}: must not be empty`)
    }
    if (opts.branch.startsWith('refs/tags/')) {
      throw new Error(`Invalid branch ${JSON.stringify(opts.branch)}: must not be a tag`)
    }
    let branch: CommittableBranch = {
      repositoryNameWithOwner: opts.repository,
      branchName: opts.branch,
    }

    // fail early to avoid surprises later
    if (opts.commitMessageFile != null) {
      try {
        commitMessage = await readFile(opts.commitMessageFile, 'utf-8')
      } catch (err) {
        throw new Error(`Failed to read commit message from file ${JSON.stringify(opts.commitMessageFile)}: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      commitMessage = opts.commitMessage
    }

    // fail early so we don't create tokens we won't use
    const r = await repo(opts.git, opts.path)

    if (!opts.dryRun) {
      if (opts.appId != null) {
        if (!opts.appKey) {
          throw new Error(`App private key is required if app id is set`)
        }
        try {
          const jwt = appJwt(opts.appId, opts.appKey)
          println(styleText('white', `Getting app ${opts.appId} installation for repo ${opts.repository}`))
          const installID = await getRepoInstallation(opts.githubApiUrl, jwt, opts.repository)
          println(styleText('white', `Generating app token for app ${opts.appId} installation ${installID}`))
          token = await createInstallationToken(opts.githubApiUrl, jwt, opts.repository, installID)
          println(styleText('white', `Have app installation token`))
          revoke = true
        } catch (err) {
          throw new Error(`Failed to create app installation token for repo ${opts.repository}: ${err}`)
        }
        println()
      } else {
        if (!opts.githubToken) {
          throw new Error(`GitHub token is required if app id is not set`)
        }
        token = opts.githubToken
      }
    }

    println(styleText('white', `Repo ${r.gitDir}`))
    const logCommit = (input: Omit<CreateCommitOnBranchInput, 'branch'>) => {
      println(styleText('gray', `  ^ ${input.expectedHeadOid}`))
      println(styleText('gray', `  # subject: ${JSON.stringify(input.message.headline)}`))
      if (input.message.body != '') {
        println(styleText('gray', `  # body ${JSON.stringify(input.message.body)}`))
      }
      for (const f of input.fileChanges.additions) {
        println(styleText('gray', `  + ${f.path} (${Buffer.from(f.contents, 'base64').length} bytes = ${f.contents.length} enc)`))
      }
      for (const f of input.fileChanges.deletions) {
        println(styleText('gray', `  - ${f.path}`))
      }
    }
    if (opts.revision == null) {
      const commit = await staged(r, commitMessage)
      if (!opts.allowEmpty && commit.input.fileChanges.additions.length === 0 && commit.input.fileChanges.deletions.length === 0) {
        println(`${styleText('yellow', `No changes to commit from staging area`)}`)
      } else {
        println()
        println(`${styleText('cyan', `${opts.dryRun ? `Would push` : `Pushing`} new commit from staging area over ${opts.repository}:${opts.branch}@${commit.input.expectedHeadOid}`)}`)
        logCommit(commit.input)
        if (!opts.dryRun) {
          const oid = await createCommitOnBranch(opts.githubGraphqlUrl, token!, {branch, ...commit.input}) as CommitOID
          println(`${styleText('green', `  = ${oid}`)}`)
          remoteOIDs.push(oid)
        }
      }
    } else {
      let prev: CommitOID | undefined
      for await (const commit of commits(r, opts.revision)) {
        if (prev) {
          commit.input.expectedHeadOid = prev
        }
        println()
        println(`${styleText('cyan', `${opts.dryRun ? `Would push` : `Pushing`} commit ${commit.local} over ${opts.repository}:${opts.branch}@${commit.input.expectedHeadOid}`)}`)
        logCommit(commit.input)
        if (!opts.dryRun) {
          const oid = await createCommitOnBranch(opts.githubGraphqlUrl, token!, {branch, ...commit.input}) as CommitOID
          remoteOIDs.push(oid)
          prev = oid
          println(`${styleText('green', ` = ${oid}`)}`)
        } else {
          prev = commit.local!.replace(/./g, '?') as CommitOID
        }
        localOIDs.push(commit.local!)
      }
      if (prev === undefined) {
        println(`${styleText('yellow', `No commits to push from ${opts.revision}`)}`)
      }
    }
  } catch (err) {
    if (err instanceof NotPushableError) {
      if (!err.message.includes('parent')) {
        err.message += ` (see https://github.com/orgs/community/discussions/191953)`
      }
      notPushable = true
    }
    println()
    if (err instanceof Error) {
      println(`${styleText(['red', 'bold'], `${err.name}:`)} ${styleText('red', err.message)}`)
      if (err.stack) {
        println()
        println(`${styleText(['gray', 'dim'], err.stack)}`)
      }
    } else {
      println(`${styleText(['red', 'bold'], `Error:`)} ${styleText('red', `${err}`)}`)
    }
    println()
    return 1
  } finally {
    done?.({
      notPushable,
      remoteOIDs: !opts.dryRun ? remoteOIDs : undefined,
      localOIDs: opts.revision != null ? localOIDs : undefined,
    })
    if (revoke) {
      println()
      try {
        println(styleText('white', `Revoking app installation token`))
        await revokeInstallationToken(opts.githubApiUrl, token!)
        println(styleText('white', `Revoked app installation token`))
      } catch (err) {
        println(styleText('yellow', `Failed to revoke app installation token, continuing anyways: ${err}`))
      }
    }
  }
  return 0
}

export function parsePrivateKey(str: string): KeyObject {
  str = str.replaceAll('\\n', '\n')
  if (/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/.test(str)) {
    str = Buffer.from(str, 'base64').toString('utf-8')
  }
  return createPrivateKey({
    key: str,
    format: 'pem',
  })
}

export function parseInteger(str: string): number {
  const v = Number(str)
  if (!Number.isInteger(v)) {
    throw new TypeError(`Invalid integer`)
  }
  return v
}

export function validateBaseUrl(str: string) {
  const u = new URL(str)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError(`Invalid protocol ${u.protocol}`)
  }
  if (!u.host) {
    throw new TypeError(`Missing host`)
  }
  if (u.search || u.hash) {
    throw new TypeError(`Must not have fragment or search params`)
  }
  if (u.username || u.password) {
    throw new TypeError(`Must not have credentials`)
  }
}
