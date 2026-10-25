import * as fs from 'node:fs';

// A run's live status file, so the pane can show agents that are running in the background.
// It holds only what the run already prints (no keys, no env). The pane treats a file as running only while
// its heartbeat is fresh and its process is alive, so a crashed run cannot look active.
export function startLiveFeed({ dir = '.', runId, scenario, title, seed, maxLines = 80 }) {
  const file = `${dir}/live-${runId}.json`;
  const state = { runId, scenario, title, seed, pid: process.pid, state: 'running', startedAt: new Date().toISOString(), updatedAt: null, lines: [], result: null };
  const write = () => {
    state.updatedAt = new Date().toISOString();
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(state)); fs.renameSync(`${file}.tmp`, file); } catch { /* the feed must never break a run */ }
  };
  write();
  const beat = setInterval(write, 2000);
  beat.unref();
  // A provider URL can carry a token in its path, so those never go into the file.
  const scrub = (l) => l.replace(/\b(?:https?|wss?):\/\/[^\s'")]*quiknode\.pro[^\s'")]*/gi, '<endpoint>').slice(0, 300);
  const line = (m) => { for (const l of String(m).split('\n')) if (l.trim()) state.lines.push(scrub(l)); if (state.lines.length > maxLines) state.lines.splice(0, state.lines.length - maxLines); write(); };
  return {
    // Same signature as console.log, so it can wrap any logger.
    log: (...a) => { console.log(...a); line(a.join(' ')); },
    // Record a line without printing it (the caller already printed it).
    note: line,
    finish(finalState, result = null) { clearInterval(beat); state.state = finalState; state.result = result; write(); },
  };
}
