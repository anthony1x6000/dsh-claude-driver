// List prices in USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
// and the Haiku 5.5 / Sonnet 5.5 launch posts. The 1-hour cache write is 2x base
// input, matching every model whose 1-hour rate is published. Haiku 5.5 is priced
// at its up-to-100k-prompt tier; prompts over 100k cost more and are not split out.

const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
}

/** Price row for a model id, accepting dated forms such as `claude-opus-5-5-20260101`. */
export function priceFor(model) {
  const key = Object.keys(PRICES).find((id) => model === id || model?.startsWith(`${id}-`))
  return key ? PRICES[key] : undefined
}

/**
 * Dollar cost of one model's cumulative usage, or null when the model has no
 * listed price. Cache writes without a reported lifetime are priced at 5m, as the
 * SDK's own cost figure does.
 */
export function costFor(model, usage) {
  const price = priceFor(model)
  if (!price) return null
  const cacheWrite1h = usage.cacheWriteEphemeral1hTokens ?? 0
  const cacheWrite5m = usage.cacheWriteTokens - cacheWrite1h
  const dollars =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    cacheWrite5m * price.cacheWrite5m +
    cacheWrite1h * price.cacheWrite1h
  return Math.round((dollars / 1_000_000) * 1e9) / 1e9
}
