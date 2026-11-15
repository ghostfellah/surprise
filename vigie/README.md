# Vigie

Repérer ce qui monte chez les spécialistes avant que la presse française n'en parle, puis l'écrire.

## Le principe

1. **Collecte** (`scripts/collect.mjs`) : Hacker News, Lobsters, GitHub (dépôts créés depuis 14 jours), Hugging Face (modèles et articles de recherche en tendance), CoinGecko et DefiLlama.
2. **Force** : chaque signal reçoit un rang de 0 à 100 au sein de sa propre source, pour comparer des métriques différentes (points, étoiles, votes).
3. **Couverture presse** : pour les 90 signaux les plus forts, un terme distinctif est extrait du titre et cherché dans Google Actualités sur 7 jours, en français et en anglais.
4. **Indice d'avance** : force × facteur de couverture. « Personne n'en parle » (0 article FR, 0 ou 1 EN), « Fenêtre ouverte » (la presse anglophone en parle, pas la française), « Encore tôt », « Déjà couvert ».
5. **Atelier** : pour un signal choisi, rédaction d'un brief, d'un post, d'un fil, d'un script vidéo ou d'une newsletter selon la ligne éditoriale saisie.

## Deux modes

- **Publié comme artifact Claude** : la page appelle Claude directement (rédaction en direct, sélection des 5 sujets du jour) et garde les idées dans la base privée de l'utilisateur.
- **Hébergement statique** (`dist/vigie/`) : aucune clé d'API. Les boutons produisent la consigne complète à coller dans Claude, et les idées restent dans le navigateur.

## Mémoire entre relevés

Le collecteur relit le relevé précédent (par défaut celui publié sur GitHub Pages, variable `VIGIE_PREV` pour une autre adresse) et garde pour chaque signal sa date de première apparition, l'historique de sa métrique et l'historique de sa couverture presse. L'interface en tire trois indicateurs :

- **Nouveau** : apparu depuis la dernière visite (ou depuis le relevé précédent à la première visite).
- **Accélère** : la métrique a gagné au moins 20 % sur les trois derniers relevés.
- **La presse arrive** : la couverture française est passée de 0-2 articles à davantage depuis que le signal est suivi. La fenêtre se referme.

Deux sources en amont de la presse s'ajoutent : **Polymarket** (marchés de prédiction dont la probabilité bouge d'au moins 5 points en 24 h, hors sport et cours de cryptos) et **Wikipédia en anglais** (pages dont les lectures sont multipliées par 2,5 ou plus en un jour).

## Secteurs, conversations et vidéo

- **Secteur** : Tous, Tech et IA, ou Crypto. Les signaux crypto viennent de CoinGecko (recherches en tendance) et de DefiLlama (protocoles dont la valeur déposée grimpe sur 7 jours).
- **Posts à commenter** : posts qui prennent sur Bluesky, Mastodon et Hacker News, classés par un indice de portée (vitesse d'engagement, peu de réponses, fraîcheur). L'atelier propose trois réponses ou une citation commentée, dans la langue du post. X et LinkedIn n'ont pas d'accès public : une zone permet d'y coller un post.
- **Script vidéo** : durée au choix (15 à 90 s), avec un plan de tournage plan par plan dont la colonne « visuel » sert de consigne à un générateur de vidéo.

## Langue et Notion

- **Langue d'écriture** : français ou anglais. En anglais, l'indice d'avance se cale sur la couverture anglophone.
- **Notion** (artifact Claude uniquement) : chaque idée peut être envoyée dans une base Notion via le connecteur Notion de l'utilisateur. La base cible se règle dans `site/config.json` (non versionné, voir `config.exemple.json`) et doit avoir les colonnes `Note` (titre), `Détails` (texte), `Étiquette` (sélection, option « Boîte à idées »), `Source` (sélection, option « Autre ») et `Thème` (sélection multiple, facultative).

## Limites

- L'extraction du terme est heuristique : un nom courant gonfle la couverture, un titre sans nom propre n'est pas mesuré.
- Les sources penchent vers la technologie et l'IA.
- Les textes générés ne connaissent que le titre et la description du signal. Il faut ouvrir la source et vérifier avant de publier.

```bash
node vigie/scripts/collect.mjs   # environ une minute
```
