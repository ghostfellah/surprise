// Assemble la version autonome (hébergement statique) dans dist/
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(resolve(root, 'site/app.html'), 'utf8');
const page = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Radar d'arbitrage de funding entre Hyperliquid, Binance et Bybit, et classement des vaults Hyperliquid.">
<script>window.CARRY_LIVE = true;</script>
</head>
<body>
${app}
</body>
</html>
`;
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), page);
copyFileSync(resolve(root, 'site/data.json'), resolve(root, 'dist/data.json'));
console.log('dist/ prêt');
