# push-signed-commits

Create verified commits for bots or workflows via the GitHub API.

### Features

- Highly flexible commit selection.
  - Supports pushing a single commit.
  - Supports pushing a range of existing commits using git's native revision [syntax](https://git-scm.com/docs/gitrevisions).
  - Supports pushing a new commit from the staging area.
- Guarantees the correctness and fidelity of pushed commits.
  - Supports pushing empty commits.
  - Specifies the expected parent commit while pushing.
  - Will preserve multi-line commit message subjects and bodies.
  - Will refuse to push commits which can't be fully represented via the API, including ones with:
    - Symlink update/creation.
    - Submodule update/creation.
    - Non-regular (i.e., executable) file update/creation.
    - *Note: I've opened a feature request to add support for these types.*
  - Uses git to do the diffing natively and reads directly from the repository rather than the working directory (unlike a few of the similar alternatives).
    - The contents will be correct.
    - The `core.autocrlf` option will be applied consistently (since git does it when adding to the index).
    - Uses plumbing commands (e.g., `diff-tree` vs `diff`) to avoid being affected by the local git config.
    - Supports [unusual](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath) filenames with special characters (newlines, tabs, quotes, backslashes, non-printable characters, etc) by using null-terminated output.
- High-quality implementation:
  - Much more error checking and validation than other similar tools.
  - Minimal implementation.
  - No dependencies other than the native git command.
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

### Examples

See `go run github.com/pgaskin/push-signed-commits@v0.0.4 -help` for more information.

##### Simple

```bash
# create and push a commit directly (and skip it if there aren't any changes to commit)
git add .
go run github.com/pgaskin/push-signed-commits@v0.0.4 -commit username/repo master $'commit message subject\n\ncommit message body'

# also automatically create and revoke an app installation token
export APP_PRIVATE_KEY=... # base64-encoded or escaped app private key
git add .
go run github.com/pgaskin/push-signed-commits@v0.0.4 -app 12345 -commit username/repo master $'commit message subject\n\ncommit message body'

# create and push a commit using git
git add .
git commit -m 'test commit'
go run github.com/pgaskin/push-signed-commits@v0.0.4 username/repo master HEAD

# push all commits created on the current branch since the last pull
go run github.com/pgaskin/push-signed-commits@v0.0.4 username/repo master HEAD@{u}..HEAD
```

##### GitHub Actions

```yaml
- run: date +%Y-%m-%d > date.txt
- run: git add . && go run github.com/pgaskin/push-signed-commits@v0.0.4 -commit "$GITHUB_REPOSITORY" "$GITHUB_REF" "automatic update"
  env:
    GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}
```

##### GitHub Actions (app)

```yaml
- uses: actions/checkout@v6
  with:
    repository: username/other-repo
    path: other-repo
    filter: blob:none
    fetch-depth: 0
- run: date +%Y-%m-%d > other-repo/date.txt
- run: git add . && go run github.com/pgaskin/push-signed-commits@v0.0.4 -app ${{vars.APP_ID}} -commit username/other-repo data "automatic update"
  env:
    APP_PRIVATE_KEY: ${{secrets.APP_PRIVATE_KEY}}
  working-directory: other-repo
```

### Compatibility

I'm still deciding what I want the CLI to look like. The arguments and output are subject to change for now, so you should pin to a specific version.

A working version should continue to work indefinitely, as it uses core git functionality and the GitHub API is unlikely to change.

### TODO

- [ ] Proper GitHub Action wrapper.
- [ ] More tests.

### Alternatives

I made this since the other ones weren't good enough, but here's a list of them anyways:

- [planetscale/ghcommit](https://github.com/planetscale/ghcommit): go, doesn't use git, need to pass all changes as command-line arguments
- [pirafrank/github-commit-sign](https://github.com/pirafrank/github-commit-sign): javascript, doesn't use git, need to pass all changes as command-line arguments
- [verified-bot-commit](https://github.com/IAreKyleW00t/verified-bot-commit): javascript, more complex, doesn't handle some edge cases, uses the old github rest git database api
- [Asana/push-signed-commits](https://github.com/Asana/push-signed-commits): python, much more complex, doesn't handle some edge cases
- [grafana/github-api-commit-action](https://github.com/grafana/github-api-commit-action): bash, creates the commit manually instead of taking an existing one, uses the working directory, doesn't handle most edge cases
- [step-security/github-api-commit-action](https://github.com/step-security/github-api-commit-action): copy of grafana/github-api-commit-action
- [github/gh-aw push_signed_commits](https://github.com/github/gh-aw/blob/48d4b85d8bceb6aaa346ad415ef4a7128c42078b/actions/setup/js/push_signed_commits.cjs): doesn't handle some edge cases, vibe-coded, very [buggy](https://github.com/github/gh-aw/pull/21576#pullrequestreview-4058718607).
- [changesets/ghcommit](https://github.com/changesets/ghcommit): typescript, uses the working directory, doesn't handle most edge cases

As of 2026-04-05, most of them don't support pushing a range of existing commits, most of them use the working copy instead of the repository index, most of the git-based ones can't handle filenames with special characters, and none of them verify that all files in the commit can actually be represented properly with the API.
