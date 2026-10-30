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
 * ponytail: module-level map, single owner, single tab. Nothing survives a page
 * reload — that is the accepted scope; add server-side versioning if multi-tab
 * or cross-device ordering ever matters.
 */
const tails = new Map<string, Promise<void>>();

/** Appends `run` after every previously chained mutation for `key`, and returns the result of `run` itself. */
export function chainMutation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const tail = tails.get(key);
  // With nothing in flight for this key the write goes out synchronously: a Save
  // must start its request now, not one microtask later, or `await`-free callers
  // would observe no request at the moment they submitted one.
  //
  // A failed predecessor must not break the chain either: the successor still has
  // to be sent, otherwise the intent it carries would be silently dropped.
  const next = tail ? tail.then(run, run) : run();
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
