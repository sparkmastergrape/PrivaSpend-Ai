import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reads only the variables this project needs, from the participant .env. Values are never logged.
const WANTED = ['AGENT_PRIVATE_KEY', 'MERCHANT_PRIVATE_KEY', 'MERCHANT_SUBMITTER_KEY', 'MERCHANT_PARTICIPANT_ID', 'MERCHANT_PAYOUT_ADDRESS', 'TEAM_NAME', 'AP4M_API_URL', 'CHANNEL_ID'];

export function loadEnv() {
  const file = process.env.ENV_FILE ?? fileURLToPath(new URL('../../ap4m-hackathon/.env', import.meta.url));
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1 || line.trim().startsWith('#')) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^"|"$/g, '');
      if (WANTED.includes(k) && v && process.env[k] === undefined) process.env[k] = v; // the shell wins
    }
  }
  const need = ['AGENT_PRIVATE_KEY', 'MERCHANT_PARTICIPANT_ID', 'MERCHANT_PAYOUT_ADDRESS', 'TEAM_NAME'];
  const missing = need.filter((k) => !process.env[k]);
  if (!process.env.MERCHANT_SUBMITTER_KEY && !process.env.MERCHANT_PRIVATE_KEY) missing.push('MERCHANT_PRIVATE_KEY');
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')} (set ENV_FILE or export them)`);
  process.env.AP4M_API_URL ??= 'https://hackathon.ap4m.build';
}
