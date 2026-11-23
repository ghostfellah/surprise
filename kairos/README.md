# Kairos

**L'emploi du temps de ton cerveau.**

Kairos prédit ton énergie heure par heure (rythme circadien, pression de sommeil, caféine) et place chaque tâche là où ton cerveau est le meilleur. Le travail qui demande de la concentration va dans tes pics, les mails et le rangement dans tes creux.

Tout se passe sur ton appareil : pas de compte, pas de serveur, pas de dépendance, pas de clé d'API. L'application fonctionne hors-ligne une fois chargée et s'installe comme une application (PWA).

## Ce que fait l'application

| Écran | Rôle |
| --- | --- |
| **Aujourd'hui** | Ton énergie en direct, la courbe de la journée, les fenêtres d'or, la caféine active, le prochain bloc, un check-in en un geste et un minuteur de focus. |
| **Planning** | Saisie rapide en français (« finir le rapport 2 h avant vendredi 17h #deep »), planificateur de semaine, glisser-déposer avec score en direct, « pourquoi ici ? », import et export `.ics`. |
| **Labo** | Simulateur « et si ? » : coucher, café, sieste. Un optimiseur propose le meilleur plan de caféine et de sieste pour ta journée. |
| **Sommeil** | Journal des nuits, dette sur 14 jours, régularité, coucher idéal ce soir, chronotype. |
| **Voyage** | Plan anti-décalage horaire jour par jour (fenêtres de lumière à chercher ou à éviter). |
| **Bilan** | Statistiques, constats chiffrés et calibration du modèle sur tes propres check-ins. |
| **Réglages** | Profil, thème, export et import JSON ou chiffré (AES-GCM), données de démo, installation. |
| **La science** | Le modèle expliqué avec des courbes interactives, ses limites et ses références. |

## Comment ça marche

1. **Prédire.** Le modèle à deux processus de Borbély (pression de sommeil S et horloge circadienne C) est étendu avec l'inertie du sommeil, un creux post-prandial et la pharmacocinétique de la caféine. Il produit une courbe d'alerte de 0 à 100 toutes les 5 minutes. Voir `docs/science.md` pour chaque paramètre et sa source.
2. **Placer.** Le planificateur construit une solution gloutonne puis la raffine par recuit simulé déterministe. Le coût compare l'exigence cognitive de chaque tâche à l'alerte prédite, respecte les échéances, les événements fixes, les pauses et le déjeuner. Il renvoie aussi le gain par rapport à une planification naïve.
3. **Prouver.** À partir d'une dizaine de check-ins (« comment te sens-tu ? »), un ajustement de Nelder-Mead borné recale ton décalage de chronotype et ton besoin de sommeil. La confiance est estimée par validation croisée, et refusée si les données sont insuffisantes.

## Limites, dites franchement

- Kairos est un outil de confort et d'organisation, **pas un dispositif médical**.
- Le modèle est un modèle de population, ajusté ensuite sur toi. Ses poids ont été réglés sur une courbe cible, pas sur un jeu de données mesuré.
- Aucune étude ne démontre à ce jour qu'un tel planificateur améliore la productivité réelle. Voir `docs/etude.md`.
- Sans capteur, la qualité de la prédiction dépend de ce que tu saisis.

## Lancer en local

```bash
npm test          # tests du moteur, du planificateur, des données et des graphiques
npm run build     # assemble dist/, dont dist/kairos/
npx --yes serve dist
```

Pour développer sans build : `cd kairos/site && python3 -m http.server 8000`, puis ouvrir `http://localhost:8000`. Les modules ES exigent un serveur HTTP, `file://` ne suffit pas.

## Structure

| Chemin | Rôle |
| --- | --- |
| `ARCHITECTURE.md` | Contrat entre les modules : modèle de données, signatures, conventions |
| `docs/science.md` | Le modèle, ses paramètres, ses sources, ses limites |
| `docs/etude.md` | Étude de positionnement et paysage concurrentiel |
| `site/index.html` | Coquille de l'application |
| `site/js/core/` | Logique pure, testée avec `node:test` : `chrono`, `caffeine`, `sleep`, `jetlag`, `model`, `scheduler`, `personalize`, `lab`, `insights`, `demo`, `nlp-fr`, `ics`, `crypto`, `time` |
| `site/js/store.js` | État, annulation, persistance locale, import et export |
| `site/js/ui/` | Interface : `app.js`, `charts.js`, `dom.js`, `modal.js`, `palette.js`, `toast.js` et `views/` |
| `site/css/` | Système de design et styles de chaque vue |
| `site/sw.js`, `site/precache.json` | Service worker et liste de fichiers pré-cachés |
| `tests/` | Tests unitaires |

## Données et vie privée

L'état est gardé dans le navigateur (IndexedDB, avec repli localStorage). Rien n'est envoyé nulle part. L'export chiffré utilise PBKDF2-SHA256 (400 000 itérations) et AES-GCM 256 ; la solidité dépend du mot de passe choisi.
