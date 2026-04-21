import pkg from '../../package.json' with { type: 'json' }
import { debuglog as debuglogNode } from 'node:util'

export function makeUserAgent(): string {
  let ua = `${pkg.name}`
  if (pkg.version) {
    ua += `/${pkg.version}`
  }

  const orch = globalThis.process?.env?.['ACTIONS_ORCHESTRATION_ID']
  if (orch) {
    ua += ` actions_orchestration_id/${orch.replace(/[^a-z0-9_.-]/gi, '_')}`
  }

  return ua
}

export function jsonify(strings: TemplateStringsArray, ...values: any[]) {
  return strings.reduce((acc, str, i) => acc + str + (i < values.length ? JSON.stringify(values[i]) : ''), '');
}

let debugLogHooks: ((msg: string) => string)[] = []

export function hookDebugLog(hook: (msg: string) => string) {
  debugLogHooks.push(hook)
}

export function debuglog(section: string): ((msg: string) => void) & { readonly enabled: boolean } {
  const debug = debuglogNode(section)
  const log = (msg: string) => {
    for (const hook of debugLogHooks) {
      msg = hook(msg)
    }
    debug('%s', msg)
  }
  return Object.defineProperty(log, 'enabled', {
    get: (): boolean => debug.enabled || debugLogHooks.length > 0,
    configurable: false,
    enumerable: true,
  }) as typeof log & { readonly enabled: boolean }
}
