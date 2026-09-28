// Postgres `uuid` columns reject anything else with a 22P02 error, which would surface
// as a 500. Route params are checked with this first so malformed ids read as unknown.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
