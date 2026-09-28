export function totalSupportedDestinations(): number {
  const parsed = Number.parseInt(import.meta.env.VITE_TOTAL_SUPPORTED_DESTINATIONS ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 20;
  return parsed;
}

export function tooManyDestinationsMessage(limit = totalSupportedDestinations()): string {
  return `You can send to at most ${limit} destinations`;
}

export function blockedDestinationsMessage(limit = totalSupportedDestinations()): string {
  return `${tooManyDestinationsMessage(limit)}. Uncheck one to choose another`;
}
