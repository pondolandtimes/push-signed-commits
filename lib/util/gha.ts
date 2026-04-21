import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync } from "node:fs"
import { EOL } from "node:os"
import { env, stdout } from "node:process"

// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands

export function debug(msg: string): void {
  issueCommand('debug', {}, msg)
}

// actions/core@v3.0.0/src/core.ts, but simpler
export function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  return env[key]?.trim() ?? ''
}

// actions/core@v3.0.0/src/core.ts, but simpler
export function setOutput(name: string, value: string): void {
  if (!issueFileCommand('OUTPUT', name, value)) {
    stdout.write(EOL)
    issueCommand("set-output", { name }, value)
  }
}

// actions/core@v3.0.0/src/command.ts, but simpler
export function issueCommand(command: string, properties: {[key: string]: any}, message: string): void {
  let props = ''
  if (properties) {
    for (const [key, val] of Object.entries(properties)) {
      if (val) {
        if (props) {
          props += ','
        } else {
          props += ' '
        }
        props += `${key}=${val.toString().replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll(':', '%3A').replaceAll(',', '%2C')}`
      }
    }
  }
  stdout.write(`::${command}${props}::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}${EOL}`)
}

// actions/core@v3.0.0/src/file-command.ts, but simpler
function issueFileCommand(command: string, key: string, value: string): boolean {
  const path = env[`GITHUB_${command}`]
  if (path) {
    if (!existsSync(path)) {
      throw new Error(`Missing ${command} command file ${path}`)
    }
    const delim = `ghadelimiter_${randomUUID()}`
    if (key.includes(delim) || value.includes(delim)) {
      throw new Error(`Key/value includes random delimiter ${delim}`)
    }
    appendFileSync(path, `${key}<<${delim}${EOL}${value}${EOL}${delim}${EOL}`, { encoding: 'utf8' })
    return true
  }
  return false
}
