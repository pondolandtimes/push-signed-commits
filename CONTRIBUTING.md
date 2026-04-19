# Contributing

## Development

```
lib/
  git.ts       - git command wrappers
  git_test.ts  - git fast-import wrapper and utils for tests
  github.ts    - minimal github api client
  commit.ts    - creates createCommitOnBranch inputs
  main.ts      - command implementation
  index.ts     - library entry point (re-exports/wraps a stable subset of the other files)
  action.ts    - github actions entry point
  cli.ts       - cli entry point
  options.ts   - cli argument parser
scripts/
  release.ts   - updates versions and documentation for releases
```

```bash
npm run lint     # type-check code
npm run build    # compile js files with stripped types
npm run release  # regenerate parts of the readme from action.yml and package.json
npm run test     # run tests with coverage
npm run cli      # run lib/main.ts from source
```

You should develop and test on the latest minor release of the oldest supported node version and the latest version of git.

The `npm run build` script is only necessary when publishing the package since node v22.18.0+ natively supports erasable typescript for files not in `node_modules`.

Don't commit the result of `npm run release` since it'll automatically get run when doing a release so the readme refers to the latest version.

The `npm run cli` script is useful for development since it doesn't require `npm run build`.

You can also run the action with a command like `env INPUT_EXAMPLE-KEY=value node lib/action.ts` (yes, that's a dash in an env var, which is why we need to use the `env` command to set it) for local testing.

Do not add any non-development dependencies.

## Versioning

Follow semantic versioning (breaking=major, features=minor, bugfixes=patch).

- The public interface of the library is defined by the typescript definitions for `index.ts` and documented behaviour. Error/debug messages may be changed.
- The public interface of the actions entrypoint is defined by the inputs/outputs in `action.yml` (console output may change between minor versions).
- The public interface of the cli is defined by the arguments, env vars, and stuff written to stdout (stderr may change between minor versions).
- A bump to the node version is a breaking change.

## Release

1. Wait for tests to complete for the latest commit.
2. Run the `release.yml` workflow with the new version number. This will commit the result of `npm run release vX.Y.Z` and create a draft release.
3. Confirm that the `package{,-lock}.json` version is correct and that the `README` has the latest version and action documentation, then publish the draft release.
4. Wait for the package to be published to NPM and the major version tag to be updated.
