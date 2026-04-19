# push-signed-commits

Create verified/signed commits as bots or GitHub Actions.

- Zero dependencies, cross-platform.
- Available as a GitHub Action, standalone CLI, or library.
- Uses an existing commit, a range of commits, or a new commit with staged changes.
- Commits will be authored by the owner of the token.
- Commits will be signed and committed by GitHub.
- Preserves the full commit message, but resets the committed/authored date.
- The new commits are not pulled automatically, but you can get the hash from the outputs.
- Rejects commits containing content not supported by the [`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch) mutation including executable files, symlinks, gitlinks, merge commits.

### Quick Start

```yaml
# with the github actions token
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    commit-message: commit message
```

```yaml
# with a github app installation token
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    path: other-repo
    repository: username/other-repo
    branch: master
    commit-message: commit message
    app-id: ${{ vars.app_id }}
    app-key: ${{ secrets.app_private_key }}
```

```bash
# with a github token (cli)
GITHUB_TOKEN=github_pat_xxx npx -y push-signed-commits@v0.1.0 -m 'commit message' username/repo master
```

```bash
# with a github app installation token (cli)
APP_PRIVATE_KEY="$(< private.pem)" npx -y push-signed-commits@v0.1.0 -C other-repo -m 'commit message' --app 1234 username/other-repo master
```

```bash
# as a library
npm install --save push-signed-commits@v0.1.0
```

### Usage

#### GitHub Actions

##### Inputs

```yaml
- uses: pgaskin/push-signed-commits@v0.1.0
  with:

    # The local repository path relative to the current directory. If you change
    # this, you probably also want to change the 'repository' and 'branch'.
    path: ''

    # The target repository username/name if not the same as the workflow. This
    # does not need to match the local repo upstream. If not on the same GitHub
    # server as the workflow, you need to override the GITHUB_API_URL and
    # GITHUB_GRAPHQL_URL environment variables.
    repository: ${{ github.repository }}

    # The target branch name if not the same as the workflow ref, optionally
    # including the 'refs/heads/' prefix. This does not need to match the local
    # repo branch. You cannot push to tags.
    branch: ${{ github.ref }}

    # The commit or commit range to push to the remote. If you want to push the
    # last local commit, use 'HEAD'. If the local branch has an upstream set,
    # you can use 'HEAD@{u}..HEAD' to push all commits added since the last
    # pull. Note that force-pushes are not supported and will be rejected. See
    # https://git-scm.com/docs/gitrevisions. If not set, a new commit will be
    # created from the staging area.
    revision: ''

    # Whether to make a new commit from the staging area even if there's nothing
    # to commit. Only used if 'revision' is not set.
    allow-empty: false

    # The commit message to use if creating a new commit from the staging area.
    commit-message: 'automatic commit'

    # The file to read the commit message from. Overrides commit-message.
    commit-message-file: ''

    # Override the user agent used to make GitHub API requests.
    user-agent: ''

    # Do not validate SSL certificates when making GitHub API requests.
    insecure: false

    # Do not push commits, just print the mutations which would be made.
    dry-run: false

    # The token to use to make GitHub API requests.
    github-token: ${{ github.token }}

    # GitHub API URL. If not set, it will be set from GITHUB_API_URL to be the
    # same as the one where the workflow is running from (e.g.,
    # https://api.github.com or https://my-ghes-server.example.com/api/v3).
    github-api-url: ''

    # GitHub GraphQL API URL. If not set, it will be set from GITHUB_GRAPHQL_URL
    # to be the same as the one where the workflow is running from (e.g.,
    # https://api.github.com/graphql or
    # https://my-ghes-server.example.com/api/graphql).
    github-graphql-url: ''

    # Authenticate as a GitHub App with the specified ID. The installation ID
    # will be detected based on 'repository'. Overrides 'github-token'. The app
    # must have the 'contents:write' permission. If you already have an app
    # installation token, you can pass it via 'github-token' instead.
    app-id: ''

    # The private key to use if authenticating as a GitHub App. Can be
    # base64-encoded or contain escaped ('\n') newlines.
    app-key: ''

    # The git binary to use. If not sepecified, the one in the PATH is used.
    git-binary: ''
```

##### Outputs

- `not-pushable` \
  Set to true if one or more commits were not pushed (the oid outputs will
  still be set to the ones pushed so far) since they contained unpushable
  content.

- `pushed-oids` \
  The new commit hash of all commits pushed, space-separated. On failure, it
  contains the ones pushed so far. Not set if 'dry-run'.

- `pushed-oid` \
  The new commit hash of the last commit pushed, or an empty string if no
  commits were pushed. On failure, it contains the ones pushed so far. Not
  set if 'dry-run'.

- `local-commit-oids` \
  The local commit hashes of all commits pushed corresponding to the ones in
  commit-oids. Not set if creating a new commit from the staging area. Still
  set if 'dry-run'.

- `local-commit-oid` \
  The local commit hashes of the last commit pushed corresponding to the
  ones in commit-oids. Not set if creating a new commit from the staging
  area. Still set if 'dry-run'.

#### CLI

```
usage: npx -y push-signed-commits@v0.1.0 [options] username/repository target_branch [revision]

      --allow-empty             create en empty commit even if there are no changes
  -m, --message message         commit message to use if creating a new commit from the staging area
  -F, --file path               read the commit message from the specified (overrides --message)
  -A, --user-agent str          override the user agent for GitHub API requests
  -k, --insecure                do not validate check tls certificates for GitHub API requests
  -n, --dry-run                 do not actually push commits, just print the mutations
      --github-token token      github token with contents:write permission (env GITHUB_TOKEN)
      --github-api-url url      github api url (env GITHUB_API_URL) (default "https://api.github.com")
      --github-grqphql-url url  github graphql api url (env GITHUB_GRAPHQL_URL) (default "https://api.github.com/graphql")
      --app id                  authenticate as a github app with the specified id (overrides --github-token)
      --app-key pem             the private key to use if authenticating as a github app (can be base64-encoded or contain escaped newlines) (env APP_PRIVATE_KEY)
      --git cmd                 the git executable to use (default "git")
  -h, --help                    show this help text
  -C  path                      repository path (default ".")

revision is a commit or range of commits (see man gitrevisions(7))
if not specified, a commit is created from the staging area
```

#### Library

See [`./lib/index.ts`](./lib/index.ts).

### Examples

#### Create and push a commit if there are staged changes

```yaml
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    commit-message: |
      commit message subject

      commit message body
```

```bash
GITHUB_TOKEN=github_pat_xxx npx -y push-signed-commits@v0.1.0 -m $'commit message subject\n\ncommit message body' username/repo master
```

#### Create and push all commits on the current branch since the last pull

```yaml
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    revision: HEAD@{u}..HEAD
```

```bash
GITHUB_TOKEN=github_pat_xxx npx -y push-signed-commits@v0.1.0 username/repo master HEAD@{u}..HEAD
```

#### Create and push all commits on the current branch since the last pull, then fetch the created commits

```yaml
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    revision: HEAD@{u}..HEAD
  id: push
- run: git fetch @{u} && git reset --soft ${{ steps.push.outputs.pushed-oid }}
  if: steps.push.outputs.commit-oid != ''
```

#### Push a single commit to a specific branch on another repository as a GitHub App

The app must have `contents:write` permission. The private key can be base64-encoded or newline-escaped.

```yaml
- uses: pgaskin/push-signed-commits@v0.1.0
  with:
    path: other-repo
    repository: username/other-repo
    branch: master
    revision: HEAD
    app-id: 1234
    app-key: ${{ secrets.app_private_key }}
```

```bash
# with a github app installation token (cli)
APP_PRIVATE_KEY="$(< private.pem)" npx -y push-signed-commits@v0.1.0 -C other-repo --app 1234 username/other-repo master HEAD
```

#### Library

```javascript
import { NotPushableError, staged, commits, createCommitOnBranch } from 'push-signed-commits'

const url = process.env['GITHUB_GRAPHQL_URL'] ?? 'https://api.github.com/graphql'
const token = process.env['GITHUB_TOKEN'] ?? ''
const git = 'git'
const path = '.'
const repo = 'username/repo'
const branch = 'master'

if (!token) {
  throw new Error('Token is required')
}

try {
  for await (const c of await commits(git, path, 'HEAD@{u}..HEAD')) {
    console.log(`pushing commit ${c.local}`)
    await createCommitOnBranch(url, token, {
      branch: {
        branchName: branch,
        repositoryNameWithOwner: repo,
      },
      ...c.input,
    })
  }

  const c = await staged(git, path, 'new commit')
  if (c.input.fileChanges.additions.length || c.input.fileChanges.deletions.length) {
    console.log('pushing staged changes')
    await createCommitOnBranch(url, token, {
      branch: {
        branchName: branch,
        repositoryNameWithOwner: repo,
      },
      ...c.input,
    })
  }
} catch (err) {
  if (err instanceof NotPushableError) {
    // ... do something
  }
  throw err
}
```

### Features

- Highly flexible commit selection.
  - Supports pushing a single commit.
  - Supports pushing a range of existing commits using git's native revision [syntax](https://git-scm.com/docs/gitrevisions).
  - Supports pushing a new commit from the staging area.
- Guarantees the correctness and fidelity of pushed commits.
  - Supports pushing empty commits.
  - Specifies the expected parent commit while pushing.
  - Preserves multi-line commit message subjects and bodies.
  - Converts non-utf-8 commit messages to utf-8.
  - Refuses to push commits which can't be fully represented via the API, including ones with:
    - Symlink update/creation.
    - Submodule update/creation.
    - Non-regular (i.e., executable) file update/creation.
    - *Note: I've opened a [feature request](https://github.com/orgs/community/discussions/191953) to add support for these types.*
  - Uses git to do the diffing natively and reads directly from the repository rather than the working directory (unlike a few of the similar alternatives).
    - The contents will be correct.
    - The `core.autocrlf` option will be applied consistently (since git does it when adding to the index).
    - Uses plumbing commands (e.g., `diff-tree` vs `diff`) to avoid being affected by the local git config.
    - Supports [unusual](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath) filenames with special characters (newlines, tabs, quotes, backslashes, non-printable characters, etc) by using null-terminated output.
- High-quality implementation:
  - Much more error checking and validation than other similar tools.
  - Minimal implementation.
  - No dependencies other than the native git command.
  - Comprehensive cross-platform test suite.
  - 100% hand-coded and tested.
- Automatically retries failed API calls.
- Supports automatically creating and revoking an app installation token.

### Limitations

- The [`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch) GraphQL mutation has some limitations:
  - On the commit:
    - Extremely large commits may fail due to size restrictions in the API.
    - The GraphQL API rate limit applies (unlike regular push operations).
    - Does not support creating new branches, the target branch must already exist.
  - On the commit metadata:
    - The author/commit date will be replaced with the current date.
    - The author will be replaced with the name/email associated with the token's owner.
    - The committer will be replaced with the web flow one (currently `GitHub <noreply@github.com>`).
    - The commit hash will change (obviously).
  - On the commit contents:
    - Does not support pushing commits with multiple parents (i.e., merge commits).
    - Does not support pushing commits containing changes to non-regular files (e.g., symlinks, submodules, executables).
- The local repository will not be automatically updated to the newly created commits (if you want that, fetch then do a `git reset --soft` to the last commit printed).

### Compatibility

This action follows semantic versioning. Release tags are immutable. You can pin it to an exact tag since a working version should continue to work for as long as the node version is supported, as it uses core git functionality and the GitHub API is unlikely to change.

The library also follows semantic versioning, but only the default exports in `index.ts` are covered.

See [CONTRIBUTING](./CONTRIBUTING.md#versioning) for more information.

### Security

There are no external dependencies and release tags are immutable.

Tokens are never printed to the output, even if verbose/debug mode is enabled.

If an app installation token is created, it is automatically revoked before the command exits.

### Alternatives

I made this since the other ones weren't good enough, but here's a list of them anyways:

- [planetscale/ghcommit](https://github.com/planetscale/ghcommit): go, doesn't use git, need to pass all changes as command-line arguments
- [pirafrank/github-commit-sign](https://github.com/pirafrank/github-commit-sign): javascript, doesn't use git, need to pass all changes as command-line arguments
- [verified-bot-commit](https://github.com/IAreKyleW00t/verified-bot-commit): javascript, more complex, doesn't handle some edge cases, uses the old github rest git database api
- [Asana/push-signed-commits](https://github.com/Asana/push-signed-commits): python, much more complex, doesn't handle some edge cases
- [grafana/github-api-commit-action](https://github.com/grafana/github-api-commit-action): bash, creates the commit manually instead of taking an existing one, uses the working directory, doesn't handle most edge cases
- [step-security/github-api-commit-action](https://github.com/step-security/github-api-commit-action): copy of grafana/github-api-commit-action
- [github/gh-aw push_signed_commits](https://github.com/github/gh-aw/blob/48d4b85d8bceb6aaa346ad415ef4a7128c42078b/actions/setup/js/push_signed_commits.cjs): doesn't handle some edge cases, vibe-coded, very [buggy](https://github.com/github/gh-aw/issues/26156).
- [changesets/ghcommit](https://github.com/changesets/ghcommit): typescript, uses the working directory, doesn't handle most edge cases

As of 2026-04-05, most of them don't support pushing a range of existing commits, most of them use the working copy instead of the repository index, most of the git-based ones can't handle filenames with special characters, and none of them verify that all files in the commit can actually be represented properly with the API.
