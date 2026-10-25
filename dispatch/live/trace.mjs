/**
 * live/trace.mjs — how a process tells the pane what it just did.
 *
 * Steps 1, 2, 3 and 5 of the x402 round trip are HTTP between the agent and the
 * merchant. They leave nothing on a ledger, so QuickNode cannot see them and the
 * pane cannot measure them. The two processes that were there report them here
 * instead, and the pane renders those steps as *reported* rather than measured.
 *
 * Fire and forget, on purpose. A pane that is not running, or a relay that is
 * slow, must never slow down or fail a payment — the payment is the real work
 * and this is only the narration.
 */

const RELAY = process.env.LIVE_TRACE_URL ?? 'http://127.0.0.1:8787/trace';

/**
 * @param {number} step   1-5, the step of the round trip
 * @param {'ok'|'warn'|'fail'|''} mark  green, amber, red, or clear it
 * @param {string} [say]  the short line shown beside the step
 * @param {{role?: string, operation?: string}} [about]
 */
export function trace(step, mark, say = '', about = {}) {
  const payload = JSON.stringify({ step, mark, say, ...about });
  // No await anywhere: the caller carries on whether or not anyone is listening.
  fetch(RELAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(1500),
  }).catch(() => { /* no pane running; the payment does not care */ });
}

/** Clear all five steps, so a new round trip starts from a blank strip. */
export function traceReset() {
  for (let step = 1; step <= 5; step += 1) trace(step, '');
}
