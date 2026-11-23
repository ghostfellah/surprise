// Génère la liste de pré-cache du service worker et une version dérivée du CONTENU des fichiers :
// un déploiement modifié change toujours le nom du cache, donc personne ne reste sur une ancienne coquille.
// Usage : node kairos/scripts/precache.mjs [dossier]   (défaut : kairos/site)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '../site'));
const EXCLUS = new Set(['sw.js', 'precache.json']);

function lister(dir) {
  return readdirSync(dir).flatMap((nom) => {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) return nom === 'dev' ? [] : lister(chemin);
    return [relative(root, chemin).split('\\').join('/')];
  });
}

const fichiers = lister(root).filter((f) => !EXCLUS.has(f)).sort();
const hash = createHash('sha256');
for (const f of fichiers) hash.update(f).update(readFileSync(join(root, f)));
const version = `kairos-${hash.digest('hex').slice(0, 10)}`;

writeFileSync(join(root, 'precache.json'), JSON.stringify({ version, assets: ['./', ...fichiers] }, null, 1) + '\n');

// La version du service worker suit le contenu : le fichier sw.js change donc à chaque livraison.
const sw = join(root, 'sw.js');
const src = readFileSync(sw, 'utf8');
const maj = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (maj === src && !src.includes(`'${version}'`)) throw new Error('VERSION introuvable dans sw.js');
writeFileSync(sw, maj);
console.log(`Kairos : ${fichiers.length} fichiers pré-cachés, version ${version}`);
