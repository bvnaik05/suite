import 'fake-indexeddb/auto'

type Replacement = Array<string | number> | Record<string, string | number>

function valueAt(replace: Replacement | undefined, key: string) {
  if (Array.isArray(replace)) {
    return replace[Number(key)]
  }

  return replace?.[key]
}

function translate(message: string, replace?: Replacement) {
  return message.replace(/\{([^}]+)\}/g, (match, key: string) =>
    String(valueAt(replace, key) ?? match),
  )
}

Object.assign(globalThis, { __: translate })
