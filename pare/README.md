# Paré au départ

Préparer un voyage au départ de France : on choisit une destination, une date, une durée et ce qui est au programme. L'application donne alors :

- **Sur place** : météo du mois, décalage horaire à la date du départ, prises électriques et besoin d'adaptateur, monnaie, numéros d'urgence, eau du robinet, sens de conduite, pourboire, langues, papiers d'entrée.
- **La valise** : liste à cocher avec quantités, calculée selon la météo, la durée, le pays et les activités. On peut ajouter ses propres objets et copier la liste.
- **Compte à rebours** : les démarches de J-60 au jour du départ, avec leur date limite et celles qui sont en retard.

Les coches et le voyage sont gardés dans le navigateur (localStorage).

## Données

- `scripts/pays.txt` : une ligne par pays (94), plus les fuseaux horaires propres à certaines destinations.
- `scripts/data.mjs` : assemble `site/voyage.json` à partir de `pays.txt` et du climat de Beau Fixe. Il échoue si un pays manque ou si un fuseau est inconnu.

```bash
node pare/scripts/data.mjs
```

Les fiches pays sont des repères généraux saisis à la main. Les formalités d'entrée changent : l'application renvoie vers France Diplomatie et ne remplace pas cette vérification.
