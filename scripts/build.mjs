// Assemble les versions autonomes (hébergement statique) dans dist/
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function page(src, description, head = '') {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="${description}">
${head}</head>
<body>
${readFileSync(resolve(root, src), 'utf8')}
</body>
</html>
`;
}

mkdirSync(resolve(root, 'dist/beau-fixe'), { recursive: true });

// Carry Radar, à la racine
writeFileSync(resolve(root, 'dist/index.html'), page('site/app.html', "Radar d'arbitrage de funding entre Hyperliquid, Binance et Bybit, et classement des vaults Hyperliquid.", '<script>window.CARRY_LIVE = true;</script>\n'));
copyFileSync(resolve(root, 'site/data.json'), resolve(root, 'dist/data.json'));

// Beau Fixe, dans /beau-fixe/
writeFileSync(resolve(root, 'dist/beau-fixe/index.html'), page('beau-fixe/site/app.html', 'Où fait-il beau, et quand partir ? Le climat de 232 destinations mois par mois sur un globe interactif.'));
for (const f of ['climat.json', 'monde.json']) copyFileSync(resolve(root, 'beau-fixe/site', f), resolve(root, 'dist/beau-fixe', f));

// Paré au départ, dans /pare/
mkdirSync(resolve(root, 'dist/pare'), { recursive: true });
writeFileSync(resolve(root, 'dist/pare/index.html'), page('pare/site/app.html', 'Préparez votre voyage : fiche pratique du pays, valise sur mesure selon la météo et compte à rebours des démarches.'));
copyFileSync(resolve(root, 'pare/site/voyage.json'), resolve(root, 'dist/pare/voyage.json'));

// Vigie, dans /vigie/
mkdirSync(resolve(root, 'dist/vigie'), { recursive: true });
writeFileSync(resolve(root, 'dist/vigie/index.html'), page('vigie/site/app.html', "Les signaux qui montent chez les spécialistes et que la presse française n'a pas encore couverts, avec un atelier de rédaction."));
copyFileSync(resolve(root, 'vigie/site/signaux.json'), resolve(root, 'dist/vigie/signaux.json'));

// Sat Radar, dans /btc/ (la page est assemblée à partir du gabarit et du moteur)
execFileSync(process.execPath, [resolve(root, 'btc/scripts/assemble.mjs')], { stdio: 'inherit' });
mkdirSync(resolve(root, 'dist/btc'), { recursive: true });
writeFileSync(resolve(root, 'dist/btc/index.html'), page('btc/site/app.html', 'Détection des creux et des sommets locaux du bitcoin, avec backtest honnête et journal de sats.', '<script>window.BTC_LIVE = true;</script>\n'));
copyFileSync(resolve(root, 'btc/site/btc.json'), resolve(root, 'dist/btc/btc.json'));

console.log('dist/ prêt');
