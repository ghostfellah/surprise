# Vigie

Repérer ce qui monte chez les spécialistes avant que la presse française n'en parle, puis l'écrire.

## Le principe

1. **Collecte** (`scripts/collect.mjs`) : Hacker News, Lobsters, GitHub (dépôts créés depuis 14 jours), Hugging Face (modèles et articles de recherche en tendance).
2. **Force** : chaque signal reçoit un rang de 0 à 100 au sein de sa propre source, pour comparer des métriques différentes (points, étoiles, votes).
3. **Couverture presse** : pour les 90 signaux les plus forts, un terme distinctif est extrait du titre et cherché dans Google Actualités sur 7 jours, en français et en anglais.
4. **Indice d'avance** : force × facteur de couverture. « Personne n'en parle » (0 article FR, 0 ou 1 EN), « Fenêtre ouverte » (la presse anglophone en parle, pas la française), « Encore tôt », « Déjà couvert ».
5. **Atelier** : pour un signal choisi, rédaction d'un brief, d'un post, d'un fil, d'un script vidéo ou d'une newsletter selon la ligne éditoriale saisie.

## Deux modes

- **Publié comme artifact Claude** : la page appelle Claude directement (rédaction en direct, sélection des 5 sujets du jour) et garde les idées dans la base privée de l'utilisateur.
- **Hébergement statique** (`dist/vigie/`) : aucune clé d'API. Les boutons produisent la consigne complète à coller dans Claude, et les idées restent dans le navigateur.

## Limites

- L'extraction du terme est heuristique : un nom courant gonfle la couverture, un titre sans nom propre n'est pas mesuré.
- Les sources penchent vers la technologie et l'IA.
- Les textes générés ne connaissent que le titre et la description du signal. Il faut ouvrir la source et vérifier avant de publier.

```bash
node vigie/scripts/collect.mjs   # environ une minute
```
