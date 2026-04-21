import { type KeyObject, createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { styleText } from 'node:util'
import { type CommitOID, repo } from '../core/git.ts'
import { NotPushableError, commits, staged } from '../core/commit.ts'
import {
  type GitHubToken,
  type GitHubApiUrl,
  type GitHubGraphqlUrl, setUserAgent,
  appJwt, getRepoInstallation, createInstallationToken, revokeInstallationToken,
  type CommittableBranch, type CreateCommitOnBranchInput, createCommitOnBranch,
} from '../core/github.ts'

export interface Input {
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

/** Generic entry point. */
export async function main(log: (msg?: string) => void, input: Input, done?: (output: Output) => void): Promise<number> {
  let revoke = false
  let commitMessage: string
  let token: GitHubToken | undefined
  let localOIDs: CommitOID[] = []
  let remoteOIDs: CommitOID[] = []
  let notPushable = false
  try {
    if (input.insecure) {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
    }
    setUserAgent(input.userAgent)

    if (!/.[/]./.test(input.repository)) {
      throw new Error(`Invalid repository ${JSON.stringify(input.repository)}: must be in username/repository format`)
    }
    if (!input.branch) {
      throw new Error(`Invalid branch ${JSON.stringify(input.branch)}: must not be empty`)
    }
    if (input.branch.startsWith('refs/tags/')) {
      throw new Error(`Invalid branch ${JSON.stringify(input.branch)}: must not be a tag`)
    }
    let branch: CommittableBranch = {
      repositoryNameWithOwner: input.repository,
      branchName: input.branch,
    }

    // fail early to avoid surprises later
    if (input.commitMessageFile != null) {
      try {
        commitMessage = await readFile(input.commitMessageFile, 'utf-8')
      } catch (err) {
        throw new Error(`Failed to read commit message from file ${JSON.stringify(input.commitMessageFile)}: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      commitMessage = input.commitMessage
    }

    // fail early so we don't create tokens we won't use
    const r = await repo(input.git, input.path)

    if (!input.dryRun) {
      if (input.appId != null) {
        if (!input.appKey) {
          throw new Error(`App private key is required if app id is set`)
        }
        try {
          const jwt = appJwt(input.appId, input.appKey)
          log(styleText('white', `Getting app ${input.appId} installation for repo ${input.repository}`))
          const installID = await getRepoInstallation(input.githubApiUrl, jwt, input.repository)
          log(styleText('white', `Generating app token for app ${input.appId} installation ${installID}`))
          token = await createInstallationToken(input.githubApiUrl, jwt, input.repository, installID)
          log(styleText('white', `Have app installation token`))
          revoke = true
        } catch (err) {
          throw new Error(`Failed to create app installation token for repo ${input.repository}: ${err}`)
        }
        log()
      } else {
        if (!input.githubToken) {
          throw new Error(`GitHub token is required if app id is not set`)
        }
        token = input.githubToken
      }
    }

    log(styleText('white', `Repo ${r.gitDir}`))
    const logCommit = (input: Omit<CreateCommitOnBranchInput, 'branch'>) => {
      log(styleText('gray', `  ^ ${input.expectedHeadOid}`))
      log(styleText('gray', `  # subject: ${JSON.stringify(input.message.headline)}`))
      if (input.message.body != '') {
        log(styleText('gray', `  # body ${JSON.stringify(input.message.body)}`))
      }
      for (const f of input.fileChanges.additions) {
        log(styleText('gray', `  + ${f.path} (${Buffer.from(f.contents, 'base64').length} bytes = ${f.contents.length} enc)`))
      }
      for (const f of input.fileChanges.deletions) {
        log(styleText('gray', `  - ${f.path}`))
      }
    }
    if (input.revision == null) {
      const commit = await staged(r, commitMessage)
      if (!input.allowEmpty && commit.input.fileChanges.additions.length === 0 && commit.input.fileChanges.deletions.length === 0) {
        log(`${styleText('yellow', `No changes to commit from staging area`)}`)
      } else {
        log()
        log(`${styleText('cyan', `${input.dryRun ? `Would push` : `Pushing`} new commit from staging area over ${input.repository}:${input.branch}@${commit.input.expectedHeadOid}`)}`)
        logCommit(commit.input)
        if (!input.dryRun) {
          const oid = await createCommitOnBranch(input.githubGraphqlUrl, token!, {branch, ...commit.input}) as CommitOID
          log(`${styleText('green', `  = ${oid}`)}`)
          remoteOIDs.push(oid)
        }
      }
    } else {
      let prev: CommitOID | undefined
      for await (const commit of commits(r, input.revision)) {
        if (prev) {
          commit.input.expectedHeadOid = prev
        }
        log()
        log(`${styleText('cyan', `${input.dryRun ? `Would push` : `Pushing`} commit ${commit.local} over ${input.repository}:${input.branch}@${commit.input.expectedHeadOid}`)}`)
        logCommit(commit.input)
        if (!input.dryRun) {
          const oid = await createCommitOnBranch(input.githubGraphqlUrl, token!, {branch, ...commit.input}) as CommitOID
          remoteOIDs.push(oid)
          prev = oid
          log(`${styleText('green', ` = ${oid}`)}`)
        } else {
          prev = commit.local!.replace(/./g, '?') as CommitOID
        }
        localOIDs.push(commit.local!)
      }
      if (prev === undefined) {
        log(`${styleText('yellow', `No commits to push from ${input.revision}`)}`)
      }
    }
  } catch (err) {
    if (err instanceof NotPushableError) {
      if (!err.message.includes('parent')) {
        err.message += ` (see https://github.com/orgs/community/discussions/191953)`
      }
      notPushable = true
    }
    log()
    if (err instanceof Error) {
      log(`${styleText(['red', 'bold'], `${err.name}:`)} ${styleText('red', err.message)}`)
      if (err.stack) {
        log()
        log(`${styleText(['gray', 'dim'], err.stack)}`)
      }
    } else {
      log(`${styleText(['red', 'bold'], `Error:`)} ${styleText('red', `${err}`)}`)
    }
    log()
    return 1
  } finally {
    done?.({
      notPushable,
      remoteOIDs: !input.dryRun ? remoteOIDs : undefined,
      localOIDs: input.revision != null ? localOIDs : undefined,
    })
    if (revoke) {
      log()
      try {
        log(styleText('white', `Revoking app installation token`))
        await revokeInstallationToken(input.githubApiUrl, token!)
        log(styleText('white', `Revoked app installation token`))
      } catch (err) {
        log(styleText('yellow', `Failed to revoke app installation token, continuing anyways: ${err}`))
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
