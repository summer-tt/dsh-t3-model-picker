import z from '@deepseek-ai/schemastery'

const favorite = z.object({
  serverId: z.union([z.string().pattern(/^[0-9a-f]{8}$/u), z.const(null)]).default(null),
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

export const Config = z.object({
  favorites: z.array(favorite).default([]).volatile(),
  legacyFavoriteImports: z.array(z.string()).default([]).volatile(),
})

export function apply() {}
