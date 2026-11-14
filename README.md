# Carry Radar

Radar d'arbitrage de funding entre Hyperliquid, Binance et Bybit, et classement des vaults Hyperliquid par rendement rapporté au risque.

## Ce que fait l'application

- **Arbitrages** : pour chaque perpétuel, la meilleure paire long/short entre venues, l'écart de funding annualisé, sa tenue sur 7 jours, le gain estimé par jour pour ton capital et le temps d'amortissement des frais.
- **Plan d'exécution** : un clic sur un actif donne les tailles, les jambes et l'historique de funding sur 7 jours.
- **Carte du funding** : tous les marchés Hyperliquid colorés selon leur funding.
- **Vaults** : encours, APR, pire creux et ratio de Calmar des vaults de plus de 100 k$.

Les calculs sont détaillés dans l'onglet « Méthode et risques ». Ce sont des estimations sur données publiques, pas un conseil en investissement.

## Lancer en local

```bash
npm run snapshot   # relève les données -> site/data.json
npm start          # assemble dist/ et sert le site
```

Aucune dépendance, aucune clé d'API. Node 20 ou plus.

## Deux modes de données

- **En direct** (version autonome, `dist/`) : le navigateur interroge l'API publique Hyperliquid toutes les 30 secondes.
- **Instantané** : `site/data.json`, produit par `scripts/snapshot.mjs`. Il fournit l'historique de funding et les vaults, et sert de repli quand l'API n'est pas joignable.

## Mise en ligne sur GitHub Pages

1. Fusionner la branche dans `main`.
2. Dans Settings → Pages, choisir « GitHub Actions » comme source.

Le workflow `.github/workflows/pages.yml` publie alors le site et rafraîchit l'instantané toutes les heures.

## Structure

| Chemin | Rôle |
| --- | --- |
| `site/app.html` | L'application (HTML, CSS et JS dans un seul fichier) |
| `site/data.json` | Dernier instantané |
| `scripts/snapshot.mjs` | Collecte des données Hyperliquid |
| `scripts/build.mjs` | Assemble la version autonome dans `dist/` |
