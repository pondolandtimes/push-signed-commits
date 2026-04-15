import { suite, after } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as git from './git.ts'

export type FastImportFile =
  | { path: string, content: string, exec?: boolean }
  | { path: string, gitlink: string }
  | { path: string, symlink: string }
  | { path: string }

// printf '%s\n' 'commit refs/test/dummy' 'mark :1' 'committer T <t@t> 999999999 +0000' 'data 7' 'dummy' '' | git fast-import --quiet && git rev-parse refs/test/dummy && git update-ref -d refs/test/dummy`
export const dummy = 'b7a2e2769a0479f89efa4c42b1eef1a5ca8dedb3' as git.CommitOID // for testing gitlinks

export class FastImport {
  private chunks: Buffer[] = []
  private mark = 1

  constructor() {
    this.commit('refs/test/dummy', 999_999_999, 'dummy\n', [], [])
  }

  private text(s: string): void {
    this.chunks.push(Buffer.from(s, 'utf-8'))
  }

  commit(ref: string, ts: number, msg: string | Buffer, parents: number[], files: FastImportFile[], encoding?: string): number {
    const mark = this.mark++
    {
      const header = [
        `commit ${ref}`,
        `mark :${mark}`,
        `committer T <t@t> ${ts} +0000`,
      ]
      if (encoding) header.push(`encoding ${encoding}`)
      this.text(header.join('\n') + '\n')
    }
    {
      const msgBuf = typeof msg === 'string' ? Buffer.from(msg, 'utf-8') : msg
      this.text(`data ${msgBuf.byteLength}\n`)
      this.chunks.push(msgBuf)
    }
    if (parents.length) {
      this.text(`from :${parents[0]}\n`)
    }
    for (const p of parents.slice(1)) {
      this.text(`merge :${p}\n`)
    }
    for (const f of files) {
      const qp = /["\\]/.test(f.path) ? '"' + f.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : f.path // just enough c-style quoting for our tests
      if ('gitlink' in f) {
        this.text(`M 160000 ${f.gitlink} ${qp}\n`)
      } else if ('symlink' in f) {
        const sb = Buffer.from(f.symlink, 'utf-8')
        this.text(`M 120000 inline ${qp}\n`)
        this.text(`data ${sb.byteLength}\n`)
        this.chunks.push(sb)
      } else if ('content' in f) {
        const cb = Buffer.from(f.content, 'utf-8')
        this.text(`M ${f.exec ? '100755' : '100644'} inline ${qp}\n`)
        this.text(`data ${cb.byteLength}\n`)
        this.chunks.push(cb)
      } else {
        this.text(`D ${qp}\n`)
      }
    }
    this.text('\n')
    return mark
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

export class TempRepo implements Disposable {
  readonly path: string
  readonly gitDir: string

  constructor(fi: FastImport) {
    this.path = realpathSync(mkdtempSync(join(tmpdir(), 'git-test-')))
    this.gitDir = join(this.path, '.git')
    this.git(['init', '-q', '--initial-branch=main', '.'])
    this.git(['config', 'core.autocrlf', 'false'])
    this.git(['fast-import', '--quiet'], fi.toBuffer())
    this.git(['read-tree', 'refs/heads/main'])
  }

  writeFile(path: string, content: string): void {
    const full = join(this.path, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  mkdir(path: string): void {
    const full = join(this.path, path)
    mkdirSync(full)
  }

  rm(path: string): void {
    rmSync(join(this.path, path))
  }

  add(...paths: string[]): void {
    this.git(['add', '--', ...paths])
  }

  rmCached(...paths: string[]): void {
    this.git(['rm', '--cached', '--', ...paths])
  }

  reset(...paths: string[]): void {
    this.git(['reset', '--', ...paths])
  }

  git(args: string[], input?: Buffer): void {
    const r = spawnSync('git', ['-C', this.path, ...args], input !== undefined ? { input } : { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`git ${JSON.stringify(args)}: exit status ${r.status}: ${Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf-8') : r.stderr}`)
  }

  revParse<T extends git.GitObjectType>(rev: git.PeeledRev<T>): git.TypedOID<T> {
    const r = spawnSync('git', ['-C', this.path, 'rev-parse', '--verify', rev], { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`git rev-parse ${rev}: ${r.stderr}`)
    return r.stdout.trim() as git.TypedOID<T>
  }

  treeFile(tree: git.Treeish, path: string): git.OID {
    const r = spawnSync('git', ['-C', this.path, 'ls-tree', '--object-only', '--end-of-options', tree, path], { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`git ls-tree ${tree} ${path}: ${r.stderr}`)
    return r.stdout.trim() as git.OID
  }

  [Symbol.dispose](): void {
    rmSync(this.path, { recursive: true, force: true })
  }
}

export function repoSuite(name: string, setup: (fi: FastImport) => void, fn: (tr: TempRepo) => void): void {
  suite(name, () => {
    const fi = new FastImport()
    setup(fi)
    const tr = new TempRepo(fi)
    after(() => {
      tr[Symbol.dispose]()
    })
    fn(tr)
  })
}
