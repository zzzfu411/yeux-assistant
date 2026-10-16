/**
 * One JSON line per operational event on stdout (container logs). Only identifiers, states and
 * timings: never request bodies, query strings, mail, notes or keys. Silent under tests.
 */
export function log(message: string, fields: Record<string, unknown> = {}) {
  if (process.env.VITEST || process.env.ASSISTANT_LOG === 'off') return;
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), msg: message, ...fields }) + '\n');
}
