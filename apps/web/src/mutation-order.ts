/**
 * Serializes persisted mutations per entity for the lifetime of the page.
 *
 * The server applies writes in arrival order and cannot tell which of two writes
 * the user asked for last. A PATCH that outlived the view which issued it (Back,
 * reopen, Settings round-trip) can therefore land after a newer PATCH and rewind
 * the stored value to a stale one — dropping the response client-side does not
 * stop the server from having recorded it. Chaining on a per-entity key makes
 * submission order the arrival order, which is the only thing a client controls
 * without a protocol change.
 *
 * Chain membership is also an *auth* claim, not only an ordering one: a closure
 * the queue still holds was written when the user had a particular session, and
 * its request carries whatever credential is current when it finally runs. So the
 * gate is checked inside the continuation, immediately before `run()` — the only
 * point that is both after the wait (where a logout can land) and before the
 * request (where the credential is read). A queued intent from a retired lifetime
 * therefore resolves `MUTATION_CANCELLED` instead of reaching the network.
 *
 * ponytail: module-level map, single owner, single tab. Nothing survives a page
 * reload — that is the accepted scope; add server-side versioning if multi-tab
 * or cross-device ordering ever matters.
 */
const tails = new Map<string, Promise<void>>();

/**
 * Auth-lifetime generation. Bumped by resetMutationQueues() — the auth boundary.
 * A closure the queue still holds from a previous lifetime must not reach the
 * network: the credentials it would send with belong to a session the user has
 * left (or, after re-login, the same user's NEW session).
 */
export const MUTATION_CANCELLED: unique symbol = Symbol("mutation-cancelled");
/** A chained mutation's result: its own value, or the retirement marker above. */
export type MutationOutcome<T> = T | typeof MUTATION_CANCELLED;

let authGeneration = 0;

/** The lifetime a would-be submitter is in now; capture it to compare after an await. */
export function currentAuthGeneration(): number {
  return authGeneration;
}

/**
 * Appends `run` after every previously chained mutation for `key`, and returns the
 * result of `run` — or `MUTATION_CANCELLED` when the auth boundary was crossed
 * between submission and the moment `run` would have started.
 */
export function chainMutation<T>(key: string, run: () => Promise<T>): Promise<MutationOutcome<T>> {
  // Captured at submission: this attempt belongs to the lifetime the caller saw.
  const generation = authGeneration;
  // Checked INSIDE the continuation, immediately before run(): everything between
  // submission and this microtask (a held predecessor, a queue drain) is exactly
  // where a logout can land, and `run` is what issues the request.
  const attempt = (): Promise<MutationOutcome<T>> =>
    generation === authGeneration ? run() : Promise.resolve(MUTATION_CANCELLED);
  const tail = tails.get(key);
  // With nothing in flight for this key the write goes out synchronously: a Save
  // must start its request now, not one microtask later, or `await`-free callers
  // would observe no request at the moment they submitted one.
  //
  // A failed predecessor must not break the chain either: the successor still has
  // to be sent, otherwise the intent it carries would be silently dropped.
  const next = tail ? tail.then(attempt, attempt) : attempt();
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, settled);
  // Prune on settle so the map never grows past the entities with a write in flight.
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return next;
}

/**
 * Auth-boundary hook: retires every chained intent and drops every tail.
 *
 * The map is page-lifetime, but intents are session-scoped. A chain (or a write
 * still hung on a dead session) that survived a logout would otherwise make the
 * *next* session's first write for that key queue behind the old intent — and be
 * sent under the new session's credentials, replaying a mutation the user asked
 * for as someone else. Clearing at the boundary means the next session submits
 * into an empty queue, and bumping the generation means an old continuation that
 * is already attached to a predecessor's promise settles as cancelled instead of
 * running: it was never submitted under the new session and its request must not
 * leave. The predecessor itself stays unsendable — it is already in flight.
 */
export function resetMutationQueues(): void {
  authGeneration++;
  tails.clear();
}
