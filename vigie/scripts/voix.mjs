// Copie les fichiers du dépôt privé GhostVoice (ton, design, règles, changelog) dans vigie/site/voix.json.
// Usage : node vigie/scripts/voix.mjs [chemin du clone, défaut /home/user/ghostvoice]
// voix.json est ignoré par git : le dépôt GhostVoice est privé, il ne va que dans l'artifact privé.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = process.argv[2] || '/home/user/ghostvoice';
if (!existsSync(dir)) { console.error('GhostVoice introuvable : ' + dir); process.exit(1); }
let rev = '';
try { rev = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch {}
const files = {};
for (const f of readdirSync(dir)) {
  if (f.startsWith('.') || !/\.(md|json|txt)$/i.test(f)) continue;
  files[f] = readFileSync(join(dir, f), 'utf8');
}
writeFileSync(new URL('../site/voix.json', import.meta.url), JSON.stringify({ rev, ts: new Date().toISOString(), files }, null, 1));
console.log('voix.json : ' + Object.keys(files).join(', ') + ' (rev ' + rev + ')');
