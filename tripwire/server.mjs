import express from 'express';
import { ethers } from 'ethers';
import fs from 'node:fs';
import { runScenario, evaluate, DEFAULT_POLICY } from './guards.mjs';
import { SOURCE_TAG } from './xrpl-tx.mjs';
import { TEST_AGENT, TEST_ATTACKER, signVoucher } from './voucher.mjs';

let policy = DEFAULT_POLICY, liveInfo = null;
if (process.env.LIVE === '1') {
  const { loadLivePolicy } = await import('./live.mjs');
  const live = await loadLivePolicy();
  policy = { ...DEFAULT_POLICY, cap: live.cap, redeemed: live.redeemed, channelId: live.source.channelId, domain: live.domain };
  liveInfo = { ...live.source, cap: String(live.cap), redeemed: String(live.redeemed) };
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const scenarios = () => JSON.parse(fs.readFileSync(new URL('./attacks.json', import.meta.url), 'utf8')).scenarios;

app.get('/api/scenarios', (_req, res) => res.json({ scenarios: scenarios() }));

app.get('/api/run', async (_req, res) => {
  const results = [];
  for (const s of scenarios()) results.push(await runScenario(s, policy));
  res.json({ sourceTag: SOURCE_TAG, mode: liveInfo ? 'live-channel-state' : 'offline', live: liveInfo, results });
});

// Judge sandbox: any pay() call the judge types goes through the same guards. Prompt text is ignored by design.
// The server signs the voucher the call would present with a throwaway test key. `forge: true` signs it with the
// attacker key instead, and `replay: true` re-presents a voucher for the amount already redeemed.
app.post('/api/inject', async (req, res) => {
  const b = req.body || {};
  const call = {
    amount: String(b.amount ?? '0.5'),
    maxPerCall: String(b.maxPerCall ?? '0.1'),
    merchantId: String(b.merchantId ?? 'MERCHANT_VERIFIED_01'),
    payout: String(b.payout ?? '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8'),
  };
  try {
    const redeemed = policy.redeemed;
    const cumulative = b.replay ? redeemed : redeemed + ethers.parseUnits(call.amount, 18);
    const signer = b.forge ? TEST_ATTACKER : TEST_AGENT;
    call.voucher = await signVoucher(signer, policy.domain, policy.channelId, cumulative);
    const r = evaluate(call, policy);
    res.json({ ...r, sourceTag: SOURCE_TAG, call, signedBy: signer.address, fundsMoved: '0 RLUSD', authorised: r.outcome === 'APPROVED' ? `${call.amount} RLUSD (voucher signed locally, not submitted)` : null });
  } catch (e) {
    res.status(400).json({ error: `bad input: ${e.message}` });
  }
});

app.get('/logo.svg', (_req, res) => res.type('image/svg+xml').send(fs.readFileSync(new URL('./logo.svg', import.meta.url))));

app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>TRIPWIRE</title>
<style>
body{background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:2rem;max-width:1100px;margin:auto}
h1{color:#ff5e00}.row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:.75rem 0}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem}
.bad{color:#f43f5e;font-style:italic}.ok{color:#22c55e;font-weight:700}.fail{color:#f59e0b;font-weight:700}
code{color:#93c5fd}
</style>
<h1><img src="/logo.svg" alt="TRIPWIRE shield logo" width="48" height="48" style="vertical-align:middle;margin-right:.5rem">TRIPWIRE: live attack board</h1>
<p><i>The agent can be talked into anything. The money can't.</i></p>
<div id="out">Running...</div>
<div class="card" style="margin-top:1rem"><h3>Judge sandbox</h3>
<p>Type your own <code>pay()</code> call. Prompt text is ignored; the guards see only amount, payee, ledger state and the signed voucher. The server signs the voucher with a throwaway test key and never submits it.</p>
<form id="f" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.5rem">
<label>amount (RLUSD)<input name="amount" value="0.5" style="width:100%"></label>
<label>max per call<input name="maxPerCall" value="0.1" style="width:100%"></label>
<label>merchant id<input name="merchantId" value="MERCHANT_VERIFIED_01" style="width:100%"></label>
<label>payout address<input name="payout" value="0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8" style="width:100%"></label>
<label><input type="checkbox" name="forge"> forge the signature</label>
<label><input type="checkbox" name="replay"> replay a redeemed voucher</label>
<button type="submit">Fire it</button></form>
<p id="sb" aria-live="polite"></p></div>
<script>
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();const d=new FormData(e.target);const b={amount:d.get('amount'),maxPerCall:d.get('maxPerCall'),merchantId:d.get('merchantId'),payout:d.get('payout'),forge:d.get('forge')==='on',replay:d.get('replay')==='on'};const sb=document.getElementById('sb');sb.textContent='Running...';
fetch('/api/inject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()).then(r=>{sb.textContent='';if(r.error){sb.append(el('span','fail',r.error));return}sb.append(el('span',r.outcome==='APPROVED'?'ok':'fail',r.outcome+(r.guard?' by '+r.guard:'')),el('div',null,r.reason),el('div',null,'Funds moved: '+r.fundsMoved+(r.authorised?' (authorised '+r.authorised+')':'')))})});
fetch('/api/run').then(r=>r.json()).then(({results,mode,sourceTag})=>{
  const out=document.getElementById('out');out.textContent='';
  const ran=results.filter(r=>!r.skipped),p=ran.filter(r=>r.pass).length,sk=results.length-ran.length;
  out.append(el('p',p===ran.length?'ok':'fail',p+'/'+ran.length+' scenarios matched expectation ('+mode+')'+(sk?', '+sk+' skipped: channel has too little cap left':'')),el('p',null,'XRPL source tag: '+sourceTag));
  for(const r of results){
    if(r.skipped){out.append(el('div','card','SKIPPED: '+r.name+' - '+r.skipped));continue}
    const row=el('div','row'),l=el('div','card'),g=el('div','card');
    l.append(el('h3',null,r.name),el('p','bad','"'+r.prompt+'"'),el('p',null,'pay('+r.call.amount+' RLUSD -> '+r.call.merchantId+')'),el('p',null,'voucher signed by '+r.signedBy));
    g.append(el('h3',null,r.outcome+(r.guard?' by '+r.guard:'')),el('p',null,r.reason),el('p',r.pass?'ok':'fail','Funds moved: '+r.fundsMoved+(r.authorised?' (authorised '+r.authorised+')':'')+(r.pass?'':'  (UNEXPECTED)')));
    row.append(l,g);out.append(row);
  }
});
</script>`));

app.listen(PORT, () => console.log(`TRIPWIRE dashboard on http://localhost:${PORT}`));
