// CO2 and API-equivalent cost of one session, from its usage rows, with claude-carbon's
// factors and prices (co2.ts, cost.ts). Pure: no Orca and no Node API.
import { co2Grams, isExcluded, type Factors, type TokenUsage } from './co2.ts'
import { costUsd, type Prices } from './cost.ts'
import { addTokens, emptyTokens, totalTokens, type Tokens, type UsageRow } from './transcript.ts'

export type Amount = { co2Grams: number; costUsd: number }

export type ModelTotals = Amount & { model: string; excluded: boolean; tokens: Tokens }

export type SessionTotals = Amount & {
  tokens: Tokens
  /** Largest first by CO2; excluded models (not Claude, or exclude_models) count 0. */
  models: ModelTotals[]
  /** Per local day the session's messages fell on. */
  days: Record<string, Amount>
}

function toUsage(t: Tokens): TokenUsage {
  return {
    input_tokens: t.input,
    cache_creation_input_tokens: t.cacheWrite,
    cache_read_input_tokens: t.cacheRead,
    output_tokens: t.output
  }
}

export function rowAmount(row: UsageRow, factors: Factors, prices: Prices | null): Amount {
  if (isExcluded(row.model, factors.excludeModels)) return { co2Grams: 0, costUsd: 0 }
  const usage = toUsage(row.tokens)
  return {
    co2Grams: co2Grams(usage, row.model, factors),
    costUsd: prices ? costUsd(usage, row.model, prices, row.tokens.cacheWrite1h) : 0
  }
}

export function sessionTotals(
  rows: UsageRow[],
  factors: Factors,
  prices: Prices | null
): SessionTotals {
  const models = new Map<string, ModelTotals>()
  const days: Record<string, Amount> = {}
  let tokens = emptyTokens()
  let co2 = 0
  let cost = 0
  for (const row of rows) {
    if (totalTokens(row.tokens) === 0) continue
    const amount = rowAmount(row, factors, prices)
    co2 += amount.co2Grams
    cost += amount.costUsd
    tokens = addTokens(tokens, row.tokens)
    const day = (days[row.day] ??= { co2Grams: 0, costUsd: 0 })
    day.co2Grams += amount.co2Grams
    day.costUsd += amount.costUsd
    const m = models.get(row.model)
    if (m) {
      m.co2Grams += amount.co2Grams
      m.costUsd += amount.costUsd
      m.tokens = addTokens(m.tokens, row.tokens)
    } else {
      models.set(row.model, {
        model: row.model,
        excluded: isExcluded(row.model, factors.excludeModels),
        co2Grams: amount.co2Grams,
        costUsd: amount.costUsd,
        tokens: { ...row.tokens }
      })
    }
  }
  return {
    co2Grams: co2,
    costUsd: cost,
    tokens,
    models: [...models.values()].sort((a, b) => b.co2Grams - a.co2Grams),
    days
  }
}
