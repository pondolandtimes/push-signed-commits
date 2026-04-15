import { spawn } from 'node:child_process'
import { debuglog } from 'node:util'

const debug = debuglog('git') // NODE_DEBUG=git

/** Git object types from object.h. */
export const objectType = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs_delta',
  7: 'ref_delta',
} as const

/** Git object type name. */
export type GitObjectType = typeof objectType[keyof typeof objectType]

/** Used for nominal typing only. Not an actual property. */
const __objectType = Symbol("git object")

/** Git object hash. */
export type TypedOID<T extends GitObjectType> = string & { readonly [__objectType]: T }
export type OIDType<T extends TypedOID<GitObjectType>> = T[typeof __objectType]
export type OID = TypedOID<GitObjectType>
export type TreeOID = TypedOID<'tree'>
export type CommitOID = TypedOID<'commit'>
export type BlobOID = TypedOID<'blob'>
export type TagOID = TypedOID<'tag'>

/** OIDs peelable to a tree. */
export type TreeishOID = TypedOID<'tree' | 'commit' | 'blob'>

/** OIDs peelable to a commit. */
export type CommittishOID = TypedOID<'commit' | 'tag'>

/** An incomplete subset of revisions guaranteed to be treeish if they exist. */
export type Treeish = "HEAD" | PeeledRev<OIDType<TreeishOID>> | TreeishOID

/** An incomplete subset of revisions guaranteed to be committish if they exist. */
export type Committish = "HEAD" | PeeledRev<OIDType<CommittishOID>> | CommittishOID

/** An explicitly peeled revision (git will treat is as not found if not the expected object type). */
export type PeeledRev<T extends GitObjectType> = `${string}^{${T}}`

/** Returns revision peeled to the specified type. */
export function peeledRev<T extends GitObjectType>(revision: string, type: T): PeeledRev<T> {
  return `${revision}^{${type}}`
}

/** Git diff status character. */
export type GitDiffStatus = typeof diffStatus[keyof typeof diffStatus]

/** Git DIFF_STATUS_ constants from diff.h, but flipped for convenience. */
export const diffStatus = {
  added: 'A',
  copied: 'C',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  typeChanged: 'T',
  unknown: 'X',
  unmerged: 'U',
} as const

// I might have gone a bit crazy with the typing here, but it was fun, I learned
// a bit, and now correctness is enforced ¯\_(ツ)_/¯
//
// I've chosen to make the types a bit stronger than strictly required, but I
// think it's nicer this way

export const [minGitMajor, minGitMinor] = [2, 38]

export class GitParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitParseError'
  }
}

export async function version(git: string): Promise<string> {
  const out = await run(false, git, null, 'version')
  const line = out.next()
  if (line.done) {
    throw new GitParseError(`Bad git version output ${out}`)
  }
  const match = /^git version (\S+)$/.exec(line.value)
  if (!match) {
    throw new GitParseError(`Bad git version line ${line.value}`)
  }
  return match[1]
}

export async function checkVersion(git: string): Promise<{
  version: string,
  compatible: boolean | undefined,
}> {
  const ver = await version(git)
  const match = /^(\d+)[.](\d+)[.](\d+)/.exec(ver) // do not anchor the end since git builds may add stuff to it
  let compatible
  if (match) {
    const major = parseInt(match[1])
    const minor = parseInt(match[2])
    compatible = major > minGitMajor || (major == minGitMajor && minor >= minGitMinor)
  }
  return {
    version: ver,
    compatible,
  }
}

export interface Repo {
  version: string,
  gitDir: string,
  head: RepoFunc<typeof head>,
  commits: RepoFunc<typeof commits>,
  message: RepoFunc<typeof message>,
  diffStaged: RepoFunc<typeof diffStaged>,
  diffTrees: RepoFunc<typeof diffTrees>,
  catFile: RepoFunc<typeof catFile>,
}

type RepoFunc<F> = F extends (git: string, repo: string, ...args: infer P) => infer R ? (...args: P) => R : never

export async function repo(git: string, repo: string): Promise<Repo> {
  const { version, compatible } = await checkVersion(git)
  if (compatible === false) { // don't fail if we can't parse the version for some reason
    throw new Error(`Incompatible git version ${version}`)
  }
  const gitDir = await absoluteGitDir(git, repo)
  return {
    version,
    gitDir,
    head: head.bind(null, git, gitDir),
    commits: commits.bind(null, git, gitDir),
    message: message.bind(null, git, gitDir),
    diffStaged: diffStaged.bind(null, git, gitDir),
    diffTrees: diffTrees.bind(null, git, gitDir),
    catFile: catFile.bind(null, git, gitDir),
  }
}

async function absoluteGitDir(git: string, repo: string): Promise<string> {
  const out = await run(false, git, repo, 'rev-parse', '--absolute-git-dir')
  return out.all('git dir')
}

export async function head(git: string, repo: string): Promise<CommitOID> {
  const out = await run(false, git, repo, 'rev-parse', '--verify', 'HEAD')
  for (const oid of out) {
    parseOID<CommitOID>(oid)
    return oid
  }
  throw new GitParseError(`Expected oid for successful rev-parse, got nothing`)
}

export async function commits(git: string, repo: string, revision: string): Promise<[CommitOID, parents: CommitOID[]][]> {
  const out = await run(false, git, repo,
    'rev-list',         // verify revs, list commits between them, and resolve them to their commit hash
    '-z',               // null-terminated output
    '--no-walk',        // if a single rev is specified, only resolve that one; ignored if a range is specified
    '--topo-order',     // order by the commit graph, not the date
    '--reverse',        // starting from the parent
    '--first-parent',   // but only follow the first parent of merge commits (we'll filter those out later anyways)
    '--parents',        // also show the commit parents
    '--end-of-options', // prevent rev from being parsed as an option
    revision,           // rev
    '--',               // prevent rev from being parsed as a path
  )
  const res: [CommitOID, parents: CommitOID[]][] = []
  for (const oid of out) {
    const s = oid.split(' ')
    const c = s.shift()
    const p = s
    if (!c) {
      throw new GitParseError('Expected at least one oid per line')
    }
    parseOID<CommitOID>(c)
    parseOIDs<CommitOID>(p)
    if (p.length !== 0 && res.length !== 0 && p[0] != res[res.length-1][0]) {
      throw new GitParseError('Expected at commits to be in topological order')
    }
    res.push([c, p])
  }
  return res
}

export async function message(git: string, repo: string, commit: Committish): Promise<string> {
  const out = await run(false, git, repo,
    '-c', 'i18n.logOutputEncoding=UTF-8', // if the commit message is not UTF-8, re-encode it
    'show',                               // show a formatted object
    '-s',                                 // only what we ask for, not the entire diff
    '--format=%B',                        // raw commit message
    '--end-of-options',                   // no more options
    commit,                               // commit
  )
  return out.all('raw commit message')
}

export type GitDiffEntry = {
  src_mode: number,
  dst_mode: number,
  src_oid: OID,
  dst_oid: OID,
  status: GitDiffStatus,
  path: string,
}

export async function diffStaged(git: string, repo: string, tree: Treeish): Promise<GitDiffEntry[]> {
  const out = await run(false, git, repo,
    'diff-index',       // low-level tree diff
    '-z',               // null-terminated
    '-r',               // recurse into trees (and don't return the trees themselves)
    '--raw',            // raw format
    '--cached',         // only index (i.e.,  staging area), not working tree files
    '--end-of-options', // no more options
    tree,               // target
  )
  return parseRawDiff(out)
}

export async function diffTrees(git: string, repo: string, a: Treeish, b: Treeish): Promise<GitDiffEntry[]> {
  const out = await run(false, git, repo,
    'diff-tree',        // low-level tree diff
    '-z',               // null-terminated
    '-r',               // recurse into trees (and don't return the trees themselves)
    '--raw',            // raw format
    '--end-of-options', // no more options
    a, b,               // trees
  )
  return parseRawDiff(out)
}

/** Parse a null-terminated raw diff (see combine_diff.c show_raw_diff). */
async function parseRawDiff(out: GitOutput): Promise<GitDiffEntry[]> {
  // ':' srcmode SP dstmode SP srcoid SP dstoid SP status [ NUL src ] NUL dst NUL
  // we didn't ask for copy or rename detection, so we should only ever have one path
  const diff = []
  for (const info of out) {
    if (!info.startsWith(':')) {
      // this would only happen if the output was bad or it gave us a rename/copy
      throw new GitParseError(json`Expected next diff entry, but got ${info}`)
    }
    const path = out.next()
    if (path.done) {
      throw new GitParseError(json`Expected path for diff entry ${info}`)
    }
    const spl = info.slice(1).split(' ')
    if (spl.length != 5) {
      throw new GitParseError(json`Invalid diff entry ${info} (bad field count)`)
    }
    const [src_mode, dst_mode, src_oid, dst_oid, status] = spl
    if (!isOctal(src_mode) || !isOctal(dst_mode)) {
      throw new GitParseError(json`Invalid diff entry ${info} (invalid mode)`)
    }
    parseOID(src_oid)
    parseOID(dst_oid)
    parseDiffStatus(status, path.value)
    diff.push({
      src_mode: parseInt(src_mode, 8),
      dst_mode: parseInt(dst_mode, 8),
      src_oid,
      dst_oid,
      status,
      path: path.value,
    })
  }
  return diff
}

export async function catFile(git: string, repo: string, oid: BlobOID): Promise<Buffer> {
  return await run(true, git, repo, 'cat-file', '--end-of-options', 'blob', oid)
}

interface GitOutput extends IteratorObject<string, void, void> {
  /** Get the next newline/null-delimited (depending on -z) item. */
  next(): IteratorResult<string, void>
  /** Get the entire newline-terminated UTF-8 output. */
  all(what: string): string
}

function run<T extends boolean>(raw: T, git: string, dir: string | null, ...args: string[]): Promise<T extends true ? Buffer : GitOutput> {
  return new Promise((resolve, reject) => {
    debug('%s', `${dir}: ${git} ${JSON.stringify(args)}`)
    const child = spawn(git, [...(dir == null ? [] : ['-C', dir]), ...args])
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', err => reject(err))
    child.on('close', (code, signal) => {
      if (code) reject(new Error(json`git ${args}: exit status ${code} (stderr: ${Buffer.concat(stderr).toString('utf-8')})`))
      else if (signal) reject(new Error(`git ${args}: killed by signal ${signal} (stderr: ${Buffer.concat(stderr).toString('utf-8')})`))
      let out: any = Buffer.concat(stdout)
      if (!raw) {
        const all = out.toString('utf-8')
        out = function* (str) {
          const delim = args.includes('-z') ? '\x00' : '\n'
          while (str.length) {
            const i = str.indexOf(delim)
            if (i == -1) {
              throw new GitParseError(json`Got garbage ${str} after last ${delim}`)
            }
            const it = str.slice(0, i)
            str = str.slice(i + 1)
            yield it
          }
        }(all)
        out = Object.defineProperty(out, 'all', {
          value: (what: string) => {
            if (all.length) {
              if (!all.endsWith('\n')) {
                throw new GitParseError(`Expected git to append a newline to the ${what}, but didn't find one: ${JSON.stringify(all)}`)
              }
              return all.slice(0, -1)
            }
            return ''
          },
          enumerable: false,
          writable: true,
          configurable: true,
        })
      }
      resolve(out)
    })
  })
}

const diffStatusSet: Set<string> = new Set(Object.values(diffStatus))

function parseDiffStatus(status: string, path?: string | undefined): asserts status is GitDiffStatus {
  if (!diffStatusSet.has(status)) {
    throw new GitParseError(json`Invalid diff status ${status}` + (path ? json`for file ${path}` : ''))
  }
}

function parseOID<T extends OID>(oid: string): asserts oid is T {
  if (!isLowerHex(oid)) {
    throw new GitParseError(json`Invalid OID ${oid}`)
  }
  if (oid.length != 40 && oid.length != 64) {
    throw new GitParseError(json`Invalid OID ${oid} length ${oid.length}`)
  }
}

function parseOIDs<T extends OID>(oids: string[]): asserts oids is T[] {
  for (const oid of oids) {
    parseOID<T>(oid)
  }
}

/**
 * Split message into the subject and body for pretty-printing according to
 * git's rules (see git/pretty.c format_subject), does NOT merge the subject
 * into a single line (so subject isn't exactly equal to --format=%s).
 */
export function splitCommitMessage(message: string): {
  subject: string,
  body: string,
} {
  message = trimBlankLinesStart(message)
  let [subject, body] = cutBlankLine(message)
  subject = trimBlankLinesEnd(subject)
  body = trimBlankLinesStart(body)
  body = trimBlankLinesEnd(body)
  return { subject, body }
}

function trimBlankLinesStart(s: string): string {
  while (true) {
    const i = s.indexOf('\n')
    if (i == -1) {
      return s
    }
    if (!isSpaceASCII(s.slice(0, i))) {
      return s
    }
    s = s.slice(i + 1)
  }
}

function trimBlankLinesEnd(s: string): string {
  while (true) {
    const i = s.lastIndexOf('\n')
    if (i == -1) {
      return s
    }
    if (!isSpaceASCII(s.slice(i + 1))) {
      return s
    }
    s = s.slice(0, i)
  }
}

function cutBlankLine(s: string): [string, string] {
  let rest = s
  while (true) {
    const i = rest.indexOf('\n')
    if (i == -1) {
      return [s, '']
    }
    if (isSpaceASCII(rest.slice(0, i))) {
      return [s.slice(0, s.length - rest.length), rest.slice(i + 1)]
    }
    rest = rest.slice(i + 1)
  }
}

function isSpaceASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case '\t':
      case '\n':
      case '\v':
      case '\f':
      case '\r':
      case ' ':
        continue
    }
    return false
  }
  return true
}

function isOctal(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (!((c >= 48 && c <= 55))) {
      return false
    }
  }
  return true
}

function isLowerHex(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) {
      return false
    }
  }
  return true
}

export const __test = {
  trimBlankLinesStart,
  trimBlankLinesEnd,
  cutBlankLine,
}

function json(strings: TemplateStringsArray, ...values: any[]) {
  return strings.reduce((acc, str, i) => acc + str + (i < values.length ? JSON.stringify(values[i]) : ''), '');
}
