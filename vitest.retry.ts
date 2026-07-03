/**
 * Retry budget for the Vitest suite (issue #393).
 *
 * A few timing/parallelism-sensitive suites — real filesystem watchers and
 * `:memory:` databases exercised under load — can produce false-negative
 * failures on shared CI runners (the ubuntu/Node legs especially). Those same
 * suites gate `npm publish` through `prepublishOnly`, so a single
 * nondeterministic failure can block a merge or abort a release mid-flow.
 *
 * Under CI we grant a small retry budget so an intermittent flake gets a second
 * chance instead of failing the whole run. Locally we grant none, so flakiness
 * surfaces immediately rather than being papered over. A test that fails on
 * every attempt still fails — this rescues the intermittent case, never a real
 * regression.
 */
export function ciRetries(env: Record<string, string | undefined>): number {
  return env.CI ? 2 : 0;
}
