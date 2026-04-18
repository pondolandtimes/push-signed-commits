import type { Commit } from './commit.ts'
import { staged as staged_, commits as commits_ } from './commit.ts'
import { repo as repo_ } from './git.ts'
import type { CreateCommitOnBranchInput, GitHubGraphqlUrl, GitHubToken, GitObjectID } from './github.ts'
import { createCommitOnBranch as createCommitOnBranch_ } from './github.ts'

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
} from "./github.ts"

export type {
  Commit,
} from './commit.ts'

export {
  NotPushableError,
} from './commit.ts'

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
 * @param message Commit message.
 * @returns The createCommitOnBranch inputs corresponding to each commit in the range in graph order, throwing a {@link NotPushableError} upon encountering one with unpushable changes.
 */
export async function* commits(git: string, repo: string, revision: string): AsyncGenerator<Commit> {
  const r = await repo_(git, repo)
  yield* commits_(r, revision)
}

/**
 * Invokes the createCommitOnBranch mutation, automatically handling retries and
 * throttling.
 * @param url GitHub GraphQL API URL.
 * @param token GitHub token with contents:write permissions.
 * @param input Input for the createCommitOnBranch mutation.
 */
export async function createCommitOnBranch(url: string, token: string, input: CreateCommitOnBranchInput): Promise<GitObjectID> {
  return createCommitOnBranch_(url as GitHubGraphqlUrl, token as GitHubToken, input)
}

// TODO: expose user agent stuff?
