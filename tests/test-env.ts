/**
 * A child environment that ambient `CAW_*` cannot steer.
 *
 * The deployed product is configured by `CAW_CONFIG` / `CAW_STATE_DIR`, and a
 * developer or CI shell that runs against the real machine usually exports them
 * (the systemd unit does, and so does any shell that has sourced the deploy
 * docs). A test harness that spawns a real child and writes
 * `env: { ...process.env, CAW_CONFIG: <its own> }` therefore looks isolated but
 * is not: `CAW_STATE_DIR` outranks the config file's `stateDir`, so the harness's
 * own config loses and the child acts on the owner's live state directory.
 *
 * That is not hypothetical. Observed on this machine: with an exported
 * `CAW_STATE_DIR`, `tests/deploy/deploy-lifecycle-contract.test.ts` read the
 * owner's real tmux socket and the real running agents ("1 managed OMP
 * agent(s)"), and `tests/server/setup-token-server-start.test.ts` wrote its
 * first-run token into the deployed state dir instead of its scratch dir. Both
 * then failed for a reason that had nothing to do with the code under test, and
 * both passed again the moment the ambient variables were removed.
 *
 * So: a harness states its own environment. Ambient product variables are
 * dropped here; the harness adds back exactly the ones it means.
 */
export function hermeticEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CAW_STATE_DIR;
  delete env.CAW_CONFIG;
  return Object.assign(env, extra);
}
