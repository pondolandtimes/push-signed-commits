import { type Commit, staged as staged_, commits as commits_ } from './core/commit.ts'
import { repo as repo_ } from './core/git.ts'
import type { CreateCommitOnBranchInput, GitHubGraphqlUrl, GitHubToken, GitObjectID } from './core/github.ts'
import { createCommitOnBranch as createCommitOnBranch_, withRetries as withMaxRetries, withUserAgent } from './core/github.ts'

// note: only stuff exported from this file is part of the stable api

/**
 * GitHub createCommitOnBranch GraphQL mutation types.
 */
export type {
  GitObjectID,
  Base64String,
  CreateCommitOnBranchInput,
  CommittableBranch,
  CommitMessage,
  FileChanges,
  FileAddition,
  FileDeletion,
} from "./core/github.ts"

export type {
  Commit,
} from './core/commit.ts'

export {
  NotPushableError,
} from './core/commit.ts'

/**
 * Create a commit from staged changes.
 * @param git Name or path of the git binary.
 * @param repo Path to the git repository (may be relative).
 * @param message Commit message.
 * @returns An object containing the createCommitOnBranch input for the commit, or throws a {@link NotPushableError} if it contains unpushable changes.
 */
export async function staged(git: string, repo: string, message: string): Promise<Commit> {
  const r = await repo_(git, repo)
  return await staged_(r, message)
}

/**
 * Create commits from one or more existing commits.
 * @param git Name or path of the git binary.
 * @param repo Path to the git repository (may be relative).
 * @param revision Commits (see man {@link https://git-scm.com/docs/gitrevisions|gitrevisions[7]}).
 * @returns The createCommitOnBranch inputs corresponding to each commit in the range in graph order, throwing a {@link NotPushableError} upon encountering one with unpushable changes.
 */
export async function* commits(git: string, repo: string, revision: string): AsyncGenerator<Commit> {
  const r = await repo_(git, repo)
  yield* commits_(r, revision)
}

export interface CreateCommitOnBranchOptions {
  /** The maximum number of retries (0 for none). */
  maxRetries?: number,
  /** Set the user agent. */
  userAgent?: string,
}

/**
 * Invokes the createCommitOnBranch mutation, automatically handling retries and
 * throttling.
 * @param url GitHub GraphQL API URL.
 * @param token GitHub token with contents:write permissions.
 * @param input Input for the createCommitOnBranch mutation.
 */
export async function createCommitOnBranch(url: string, token: string, input: CreateCommitOnBranchInput, options?: CreateCommitOnBranchOptions): Promise<GitObjectID> {
  let tok = String(token) as GitHubToken
  if (options?.maxRetries != undefined) {
    tok = withMaxRetries(tok, options?.maxRetries)
  }
  if (options?.userAgent != undefined) {
    tok = withUserAgent(tok, options?.userAgent)
  }
  return createCommitOnBranch_(url as GitHubGraphqlUrl, tok, input)
}
