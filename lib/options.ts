import { argv as procArgv, env as procEnv } from 'node:process'

// TODO: maybe make this a standalone library (I was originally going to do the
// arg parsing ad-hoc, but kept refactoring it since it was fun and ended up
// making a relatively generic solution...)?

// TODO: test

/** Option types. */
export type OptionType = {
  /** bool: -o, --opt, $ENV=true|t|1|y|yes|false|f|0|n|no (no default value allowed) */
  bool: boolean,
  /** str: -ovalue, --opt=value, -o value, --opt value, $env=value */
  str: string,
}

/** Option type default values. */
export const OptionDefault = {
  bool: 'false',
  str: '',
} as const satisfies Record<keyof OptionType, string>

/** Whether an option type requires a value when specified on the command-line. */
const OptionHasArgumentValue = {
  bool: false,
  str: true,
} as const satisfies Record<keyof OptionType, boolean>

/** Option definition. */
export interface Option<T extends keyof OptionType = keyof OptionType> {
  type: T,
  help?: string,
  long?: string,
  short?: string,
  env?: string,
  kind?: string,
  default?: T extends keyof OptionType ? typeof OptionHasArgumentValue[T] extends true ? string : never : never,
  parse?(v: OptionType[T]): any,
};

/** Parsed option value. */
export type OptionValue<T extends Option> = T extends Option<infer U> ?
  T['parse'] extends (v: any) => infer R
  ? R
  : OptionType[U]
  : never

/**
 * Option definitions.
 *
 * When definining a variable of this type, use `as const satisfies Options` to
 * prevent type widening so types actually get checked properly and type
 * inference works for {@link ParsedOptions}.
 */
export type Options = Record<string, { [K in keyof OptionType]: Option<K> }[keyof OptionType]>

/** Parsed option values. */
export type ParsedOptions<T extends Options> = {
  [K in keyof T]: OptionValue<T[K]>
}

/** Represents an issue with a user-provided option. */
export class OptionError extends Error {
  what: string | null
  opt: Option | null
  constructor(what: string | null, opt: Option | null, why?: string) {
    super(`${what ? `${what}: ` : ``}${opt ? why || 'invalid argument' : 'unknown option'}`)
    this.name = 'OptionError'
    this.what = what || null
    this.opt = opt || null
  }
}

/** Parse the value of a single option. Throws an {@link OptionError} if invalid. */
export function parseOption<T extends Option>(opt: T, value: string): OptionValue<T> {
  let v: any
  switch (opt.type) {
    case 'bool':
      if (/^(true|t|1|y|yes)$/i.test(value)) v = true
      else if (/^(false|f|0|n|no)$/i.test(value)) v = false
      else throw new OptionError(null, opt, `invalid ${opt.kind || opt.type} ${JSON.stringify(value)}`)
      break
    case 'str':
      v = value
      break
    default:
      const invalid: never = opt.type
      throw new TypeError(`Invalid type ${invalid}`)
  }
  try {
    return (opt.parse ? opt.parse(v) : v) as any
  } catch (err) {
    throw new OptionError(null, opt, `invalid ${opt.kind || opt.type}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Validate option definitions and return the parsed default options. Throws a
 * {@link TypeError} if opts is invalid.
 */
export function parseDefaultOptions<T extends Options>(opts: T): ParsedOptions<T> {
  for (const [key, opt] of Object.entries(opts)) {
    if (!Object.keys(OptionDefault).includes(opt.type)) {
      throw new TypeError(`Argument ${key} has invalid type ${opt.type}`)
    }
    if (opt.long && !/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(opt.long)) {
      throw new TypeError(`Invalid long option --${opt.long} for argument ${key}`)
    }
    if (opt.short && !/^[a-zA-Z0-9]$/.test(opt.short)) {
      throw new TypeError(`Invalid short option -${opt.short} for argument ${key}`)
    }
    if (opt.env && !/^[A-Z_]+$/.test(opt.env)) {
      throw new TypeError(`Invalid env var $${opt.env} for argument ${key}`)
    }
    if (!OptionHasArgumentValue[opt.type] && opt.default !== undefined) {
      throw new TypeError(`Argument ${key} of type ${opt.type} must not have a default value`)
    }
    if (typeof opt.default !== 'undefined' && typeof opt.default !== 'string') {
      throw new TypeError(`Argument ${key} has non-string default ${typeof opt.default} (it must be a raw string which will get parsed)`)
    }
  }
  const res: Record<string, any> = {}
  for (const [key, opt] of Object.entries(opts)) {
    const def = opt.default ?? OptionDefault[opt.type]
    try {
      res[key] = parseOption(opt, def)
    } catch (err) {
      throw new TypeError(`Argument ${key}: Invalid default value ${JSON.stringify(def)}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return res as ParsedOptions<T>
}

/**
 * Parse
 * {@link https://www.gnu.org/software/guile/manual/html_node/Command-Line-Format.html|GNU-style}
 * options from the command-line arguments and environment. Throws an error if
 * opts is invalid. Throws an {@link OptionError} if argv or env contains an
 * invalid option or a {@link TypeError} if opts is invalid.
 */
export function parseOptions<T extends Options>(
  opts: T,
  argv: string[] = procArgv.slice(2),
  env: { [key: string]: string | undefined } = procEnv,
): {
  opts: ParsedOptions<T>,
  args: string[]
} {
  // validate options, set defaults
  const res = parseDefaultOptions(opts) as Record<string, any>

  // collect options
  const all: ({ key: keyof T & string } & Option)[] = []
  const long = new Map<string, typeof all[number]>()
  const short = new Map<string, typeof all[number]>()
  for (const [k, d] of Object.entries(opts)) {
    all.push({ key: k, ...d })
  }
  for (const opt of all) {
    if (opt.long) {
      if (long.has(opt.long)) {
        throw new TypeError(`Duplicate option --${opt.long} (${opt.key})`)
      }
      long.set(opt.long, opt)
    }
    if (opt.short) {
      if (short.has(opt.short)) {
        throw new TypeError(`Duplicate option -${opt.short} (${opt.key})`)
      }
      short.set(opt.short, opt)
    }
  }

  // argument value parser
  const parse = (opt: typeof all[number], what: string, value: string) => {
    try {
      res[opt.key] = parseOption(opt, value)
    } catch (err) {
      throw new OptionError(what, opt, `${err instanceof Error ? err.message : err}`)
    }
  }

  // set values from environment variables
  for (const opt of all) {
    if (opt.env) {
      const value = env[opt.env]
      if (value || value === '') {
        parse(opt, `$${opt.env}`, value)
      }
    }
  }

  // split explicit positional arguments
  const split = argv.indexOf('--')
  const tail = split >= 0 ? argv.slice(split + 1) : []
  let toks = split >= 0 ? argv.slice(0, split) : [...argv]

  // split --long=val into --long val
  toks = toks.flatMap(arg => {
    if (arg.startsWith('--')) {
      const i = arg.indexOf('=', 2)
      if (i >= 0) {
        const name = arg.slice(2, i)
        if (!long.get(name)) {
          throw new OptionError(`--${name}`, null)
        }
        return [`--${name}`, arg.slice(i + 1)]
      }
    }
    return [arg]
  })

  // expand -abcvalue into -a -b -c value
  toks = toks.flatMap(arg => {
    if (arg.startsWith('-') && !arg.startsWith('--')) {
      const res: string[] = []
      for (let j = 1; j < arg.length;) {
        const c = arg[j++]!
        const opt = short.get(c)
        if (opt) {
          res.push(`-${c}`)
          if (OptionHasArgumentValue[opt.type]) {
            const value = arg.slice(j)
            if (value.length) {
              res.push(value)
            }
            break
          }
          continue
        }
        throw new OptionError(`-${c}`, null)
      }
      return res
    }
    return [arg]
  })

  // set values from arguments
  const pos = []
  for (let i = 0; i < toks.length;) {
    const arg = toks[i++]!
    let name, opt
    if (arg.startsWith('--')) {
      name = arg.slice(2)
      opt = long.get(name)
    } else if (arg.startsWith('-')) {
      name = arg.slice(1)
      opt = short.get(name)
    } else {
      pos.push(arg)
      continue
    }
    if (!opt) {
      throw new OptionError(null, null)
    }
    switch (opt.type) {
      case 'bool':
        parse(opt, arg, 'true')
        break
      default:
        if (!OptionHasArgumentValue[opt.type]) {
          throw new TypeError('WTF')
        }
        if (i >= toks.length) {
          throw new OptionError(arg, opt, 'missing value')
        }
        parse(opt, arg, toks[i++]!)
    }
  }
  pos.push(...tail)

  return {opts: res as ParsedOptions<T>, args: pos}
}

/** Generate help text for opts. */
export function help(opts: Options): string {
  parseDefaultOptions(opts) // validate
  const rows: [string, string][] = []
  for (const opt of Object.values(opts)) {
    if (opt.help) {
      const value = OptionHasArgumentValue[opt.type]
        ? ` ${opt.kind || opt.type}`
        : ``
      const name = opt.short && opt.long
        ? `-${opt.short}, --${opt.long}${value}`
        : opt.short
          ? `-${opt.short} ${value}`
          : opt.long
            ? `    --${opt.long}${value}`
            : ``
      const env = opt.env
        ? ` (env ${opt.env})`
        : ``
      const def = opt.default || opt.default == ''
        ? ` (default ${JSON.stringify(opt.default)})`
        : ``
      rows.push([`${name}`, `${opt.help}${env}${def}`])
    }
  }
  const width = rows.reduce((m, [l]) => Math.max(m, l.length), 0)
  return rows.map(([l, h]) => `  ${l.padEnd(width)}  ${h}`).join('\n')
}
