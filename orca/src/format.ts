// How the status bar and the panel write amounts. Pure.

/** Joins a number to its unit so a line never breaks between them. */
export const NBSP = '\u00a0'

export const CO2_UNITS = { g: 'gCO₂e', kg: 'kgCO₂e' } as const

/** A CO2 amount as number and unit: grams under a kilogram, kilograms above. */
export function co2Parts(grams: number): { value: string; unit: string } {
  if (grams >= 1000) return { value: (grams / 1000).toFixed(2), unit: CO2_UNITS.kg }
  const value = grams >= 100 ? grams.toFixed(0) : grams >= 10 ? grams.toFixed(1) : grams.toFixed(2)
  return { value, unit: CO2_UNITS.g }
}

/** Every CO2 amount the plugin shows: "196 gCO₂e", "59.79 kgCO₂e", never split. */
export function formatCo2(grams: number): string {
  const { value, unit } = co2Parts(grams)
  return `${value}${NBSP}${unit}`
}

export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`
}

export function statusText(latestGrams: number | null, todayGrams: number): string {
  const latest = latestGrams === null ? 'No session' : formatCo2(latestGrams)
  return `${latest} · today ${formatCo2(todayGrams)}`
}

/** "less than a minute ago" under 60 s, then "N min ago", "N h ago", "N d ago". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, (now - at) / 1000)
  if (seconds < 60) return 'less than a minute ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
