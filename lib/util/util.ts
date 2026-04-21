import pkg from '../../package.json' with { type: 'json' }

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
