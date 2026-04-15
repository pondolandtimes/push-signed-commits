import type { BlobOID, CommitOID, GitDiffEntry, Repo } from "./git.ts"
import type { CreateCommitOnBranchInput, FileChanges } from "./github.ts"
import { encodeBase64 } from "./github.ts"
import { diffStatus, splitCommitMessage } from "./git.ts"

export class NotPushableError extends Error {
  public commit: CommitOID | undefined
  public path: string | undefined

  constructor(commit: CommitOID | undefined, message: string, path?: string | undefined) {
    super(`${commit ? `Commit ${commit}` : `Staging area`} is not pushable: ${message}${path ? ` ${path}` : ''}`)
    this.name = 'NotPushableError'
    this.commit = commit
    this.path = path
  }
}

export interface Commit {
  input: Omit<CreateCommitOnBranchInput, 'branch'>,
  local: CommitOID | null,
}

export async function staged(repo: Repo, message: string): Promise<Commit> {
  const parent = await repo.head()
  const files = await repo.diffStaged(parent)

  const { subject, body } = splitCommitMessage(message)
  const { additions, deletions } = await changes(repo, files)

  return {
    input: {
      message: {
        headline: subject,
        body: body,
      },
      fileChanges: {
        additions,
        deletions,
      },
      expectedHeadOid: parent,
    },
    local: null,
  }
}

export async function* commits(repo: Repo, revision: string): AsyncGenerator<Commit> {
  for (const [commit, parents] of await repo.commits(revision)) {
    switch (parents.length) {
      case 0:
        throw new NotPushableError(commit, `has no parents (creating a new branch is not supported)`)
      case 1:
        break
      default:
        throw new NotPushableError(commit, `has multiple parents (merge commits are not supported)`)
    }
    const parent = parents[0]

    const message = await repo.message(commit)
    const { subject, body } = splitCommitMessage(message)

    const files = await repo.diffTrees(parent, commit)
    const { additions, deletions } = await changes(repo, files, commit)

    yield {
      input: {
        message: {
          headline: subject,
          body: body,
        },
        fileChanges: {
          additions,
          deletions,
        },
        expectedHeadOid: parent,
      },
      local: commit,
    }
  }
}

export async function changes(repo: Repo, diff: GitDiffEntry[], commit?: CommitOID | undefined): Promise<FileChanges> {
  const additions = []
  const deletions = []
  for (const file of diff) {
    switch (file.status) {
      case diffStatus.added:
      case diffStatus.modified:
      case diffStatus.typeChanged:
        // git@v2.53.0/fsck.c:722-743
        switch (file.dst_mode) {
          /* node:coverage ignore next 2 */
          case 0o040000: // tree (directory)
            throw new Error(`WTF: Why did a recursive ls-tree/ls-files return a directory`)
          case 0o100644: // regular file
          case 0o100664: // regular file (legacy)
            break // okay
          case 0o100755: // executable file
            throw new NotPushableError(commit, `contains an executable file`, file.path)
          case 0o120000: // symlink
            throw new NotPushableError(commit, `contains a symbolic link`, file.path)
          case 0o160000: // gitlink (submodule)
            throw new NotPushableError(commit, `contains a submodule`, file.path)
          /* node:coverage ignore next 2 */ // all known git objects covered
          default:
            throw new NotPushableError(commit, `contains a non-regular (mode ${file.dst_mode}) file`, file.path)
        }
        additions.push({
          path: file.path,
          contents: encodeBase64(await repo.catFile(file.dst_oid as BlobOID)),
        })
        break

      case diffStatus.deleted:
        deletions.push({
          path: file.path,
        })
        break

      default:
        throw new NotPushableError(commit, `unsupported diff status ${file.status} for entry`, file.path)
    }
  }
  return { additions, deletions }
}
