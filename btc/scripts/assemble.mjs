// Assemble btc/site/app.html : insère le moteur (engine.cjs) dans le gabarit de la page.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'src/app.src.html'), 'utf8');
const engine = readFileSync(resolve(root, 'src/engine.cjs'), 'utf8').replace(/<\/script/gi, '<\\/script');
if (!src.includes('/*ENGINE*/')) throw new Error('marqueur /*ENGINE*/ introuvable');
writeFileSync(resolve(root, 'site/app.html'), src.replace('/*ENGINE*/', () => engine));
console.log('btc/site/app.html assemblé');
