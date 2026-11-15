# Beau Fixe

Où fait-il beau, et quand partir ? On choisit un mois, une température idéale, sa tolérance à la pluie et un type de séjour. Le globe et le classement notent 232 destinations, et chaque fiche montre le climat sur douze mois et les meilleurs mois pour y aller.

## Données

- `scripts/destinations.txt` : la liste des destinations (nom, pays, région, coordonnées, altitude, types). Ajouter une ligne suffit pour ajouter un lieu.
- `scripts/climate.mjs` : interroge les climatologies NASA POWER (moyennes 2001-2025) et écrit `site/climat.json`.
- `site/monde.json` : contours des pays (Natural Earth 1:110m, paquet `world-atlas`).

Les valeurs viennent de mailles d'environ 50 km recalées sur l'altitude du lieu. L'écart avec une station météo peut atteindre 2 à 3 °C, surtout sur les petites îles et en montagne.

## Lancer

```bash
node beau-fixe/scripts/climate.mjs   # seulement pour régénérer le climat
npm start                            # depuis la racine, puis ouvrir /beau-fixe/
```

## La note

Sur 100 : proximité entre la température de l'après-midi et la température idéale, multipliée par un facteur de pluie (selon la tolérance choisie) et un facteur de ciel dégagé, avec un léger malus quand il fait chaud et très humide.
