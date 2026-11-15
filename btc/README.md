# Sat Radar

Tableau de bord des creux et des sommets locaux du bitcoin (bougies de 4 h), pensé pour un objectif : plus de satoshis.

## Ce qu'il contient

- **Deux scores sur 100** (creux, sommet) : neuf composantes à poids fixes (RSI 4 h et journalier, Bandes de Bollinger, écart à l'EMA 50, distance au plus haut/bas de 60 jours, mèche et volume de capitulation, divergence du RSI, Fear & Greed, MVRV). Les poids sont choisis à l'avance et jamais ajustés sur l'historique.
- **Graphique 4 h** avec EMA, marqueurs d'alerte et scores.
- **Contexte** : funding et open interest (Hyperliquid), ratio long/short (OKX), DVOL et put/call (Deribit), marge (Bitfinex), hash ribbons (mempool.space). Indicatif, hors score.
- **Plan chiffré** (entrée, invalidation, objectifs, ratio gain/risque, taille de position selon le risque accepté).
- **Le test de vérité** : trois méthodes mesurées en nombre de BTC, sur huit ans, avec sélection des réglages sur 2018-2022 et jugement sur 2023-aujourd'hui.
- **Journal de sats** : compare le stack de l'utilisateur à celui qu'il aurait en ne faisant rien.
- **Lecture de Claude** (artifact Claude uniquement).

## Ce que le test de vérité montre

Sur les données relevées, aucune des trois méthodes (vendre les sommets et racheter les creux, DCA avec réserve de cash déployée sur signal de creux, filtre de tendance sur moyenne mobile) ne bat de façon fiable la simple détention de BTC hors échantillon. Le tableau de bord est donc un outil de lecture du marché et de gestion du risque, pas une machine à produire des sats. Les chiffres exacts sont recalculés à chaque relevé et affichés dans la page.

## Sans anticipation

- Le score d'une bougie n'utilise que des données connues à sa clôture. Les pivots du RSI sont confirmés avec 5 bougies de retard. Fear & Greed et MVRV sont décalés d'un jour.
- La bougie en cours n'est jamais notée.
- Les ordres du backtest s'exécutent à l'ouverture de la bougie suivante, avec 0,15 % de coût par ordre.

## Fichiers

| Chemin | Rôle |
| --- | --- |
| `src/engine.cjs` | Moteur : indicateurs, scores, backtest, tests (pur calcul, sans réseau) |
| `src/app.src.html` | Gabarit de la page |
| `scripts/assemble.mjs` | Insère le moteur dans le gabarit -> `site/app.html` |
| `scripts/collect.mjs` | Relevé des données, calculs, écriture de `site/btc.json` |

```bash
node btc/scripts/collect.mjs    # environ 20 secondes
node btc/scripts/assemble.mjs   # reconstruit site/app.html
```

## Limites

- Données de prix : Bitstamp BTC/USD (spot), historique depuis 2017. Binance et Bybit ne sont pas joignables depuis l'infrastructure de relevé.
- Fear & Greed démarre en février 2018 : les scores ne sont calculés qu'à partir de mars 2018.
- Peu d'épisodes aux seuils élevés (6 creux ≥ 60 en huit ans) : toute statistique sur ces signaux est fragile.
- Pas un conseil en investissement.
