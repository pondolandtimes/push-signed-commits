#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

console.log(`Parsing package.json`)
const obj = JSON.parse(readFileSync('package.json', 'utf-8'))
const repo = obj.repository?.url?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') ?? ''

console.log("Parsing inputs/outputs from action.yml")
const action: Record<'inputs' | 'outputs', Record<string, { lines: string[], default?: string }>> = { inputs: {}, outputs: {} }
{
  let section: 'inputs' | 'outputs' | null = null
  let name = ''
  let lines: string[] = []
  let def: string | undefined
  let inDesc = false
  function flush() {
    if (name && section) action[section][name] = { lines, ...(def !== undefined ? { default: def } : {}) }
    name = ''; lines = []; def = undefined; inDesc = false
  }
  for (const line of readFileSync('action.yml', 'utf-8').split('\n')) {
    if (line === 'inputs:') { flush(); section = 'inputs'; continue }
    if (line === 'outputs:') { flush(); section = 'outputs'; continue }
    if (!section || (!line.startsWith(' ') && line !== '')) { if (!line.startsWith(' ') && line !== '') section = null; continue }
    const indent = line.length - line.trimStart().length
    const trimmed = line.trimStart()
    if (indent === 2) { flush(); name = trimmed.replace(/:$/, ''); continue }
    if (indent === 4) {
      inDesc = false
      if (trimmed.startsWith('description:')) { const v = trimmed.slice('description:'.length).trim(); lines = v ? [v] : []; inDesc = true }
      else if (trimmed.startsWith('default:')) { def = trimmed.slice('default:'.length).trim() }
      continue
    }
    if (indent >= 6 && inDesc) { lines.push(trimmed); continue }
    inDesc = false
  }
  flush()
}
if (!Object.keys(action.inputs).length || !Object.keys(action.outputs).length) throw new Error(`Failed to parse action.yml`)

console.log(`Parsing version`)
if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error(`Failed to extract github repository from package.json`)
const version = process.argv[2] ?? `v${obj.version}`
const versionRe = `v[0-9]+[.][0-9]+[.][0-9]+`
if (!version || !(new RegExp(`^${versionRe}$`)).test(version)) throw new Error(`Invalid version ${versionRe}`)

console.log()
console.log(`Releasing ${repo}@${version}`)

console.log("Updating README")
let readme = readFileSync('README.md', 'utf-8')
if (!(new RegExp(`${repo}@v`, 'i')).test(readme)) throw new Error(`No version references found in README`)
readme = readme.replace(new RegExp(`(${repo}@)${versionRe}`, 'gi'), `$1${version}`)
readme = readme.replace(new RegExp(`(${repo}@)v[0-9]+(?![.][0-9])`, 'gi'), `$1${version.split('.')[0]}`)
if (!readme.includes('#### Inputs\n')) throw new Error('Inputs section not found in README')
if (!readme.includes('#### Outputs\n')) throw new Error('Outputs section not found in README')
readme = readme.replace(/(#### Inputs\n\n)```yaml\n[\s\S]*?```/, `$1\`\`\`yaml\n${[
  `- uses: ${repo}@${version}\n  with:`,
  ...Object.entries(action.inputs).map(([k, v]) => [
    ...v.lines.map(l => '    # ' + l),
    `    ${k}: ${/^(true|false|\d+|\$\{\{.+\}\})$/.test(v.default ?? '') ? v.default : `'${v.default ?? ''}'`}`,
  ].join('\n')),
].join('\n\n').replaceAll('$', '$$')}\n\`\`\``)
readme = readme.replace(/(#### Outputs\n\n)([\s\S]*?)(\n### )/, `$1${[
  ...Object.entries(action.outputs).map(([k, v]) => [
    `- \`${k}\``,
    ...v.lines.map(l => '  ' + l),
  ].join('\n')),
].join('\n\n').replaceAll('$', '$$')}\n$3`)
writeFileSync('README.md', readme)

console.log("Updating package.json version")
let pkg = readFileSync('package.json', 'utf-8')
pkg = pkg.split('\n').map(x => x.includes('"version"') ? x.replace(new RegExp(versionRe.slice(1)), version.slice(1)) : x).join('\n')
writeFileSync('package.json', pkg)

console.log("Updating package-lock.json metadata")
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { stdio: 'inherit' })
