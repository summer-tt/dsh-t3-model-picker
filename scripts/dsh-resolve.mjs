// Resolve the Host half's `@deepseek-ai/*` import from the installed DSH
// copy of that package, as the plugin loader does at runtime.
// Registered by verify-host-favorites.mjs through module.register(); the
// package's own package.json URL (…/node_modules/@deepseek-ai/schemastery/)
// arrives through initialize(data), so the import resolves from that package.
let packageUrl

export async function initialize(data) {
  packageUrl = new URL(data)
}

export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery' && (context.parentURL ?? '').endsWith('/index.js')) {
    return next(specifier, { ...context, parentURL: packageUrl.href })
  }
  return next(specifier, context)
}
