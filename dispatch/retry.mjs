// Retry only transient failures: a non-JSON (HTML) gateway response, network errors, HTTP 5xx/429,
// or a payout still waiting for confirmations. Deterministic errors (4xx) are thrown immediately.
export function isTransient(err) {
  const msg = String(err?.message ?? err);
  return err instanceof SyntaxError
    || err instanceof TypeError
    || /\((5\d\d|429)\)/.test(msg)
    || /still waiting for confirmations/.test(msg)
    || err?.code === 'ATTEMPT_TIMEOUT'
    || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

export async function withRetry(fn, { attempts = 5, baseMs = 2000, attemptTimeoutMs = 60_000, retryIf = isTransient, label = 'call', log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await withTimeout(fn(), attemptTimeoutMs);
    } catch (err) {
      if (i >= attempts || !retryIf(err)) throw err;
      const wait = baseMs * 2 ** (i - 1);
      log(`   ⚠️ ${label} attempt ${i}/${attempts} failed (${String(err.message ?? err).slice(0, 80)}); retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
}

// A request with no timeout can hang forever; turn that into a retryable failure.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`attempt timed out after ${ms / 1000}s`), { code: 'ATTEMPT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
