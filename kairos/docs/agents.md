# Kairos pour les agents — spécification du protocole

> Statut : **spécification + sémantique de référence**. Ce qui existe : les fonctions pures des outils
> (`site/js/core/agent-tools.js`), les schémas JSON publiés, des exemples et des tests, et une page de démonstration
> (`/kairos/agents.html`). Ce qui n'existe **pas encore** : le serveur MCP, la boîte de réception dans l'interface,
> l'authentification par jetons et le relais chiffré. Chaque section dit de quel côté elle se situe.

## Aperçu : à quoi ça ressemble

> Les captures ci-dessous montrent l'application réelle avec les **données de démonstration** (fictives), mardi 24 novembre, 10 h 20.
> La seule image qui ne vient pas de l'application est la **maquette** de la boîte de réception, étiquetée comme telle : cette interface n'est pas construite.

### Là où atterrit ce que tu acceptes (application réelle)

Une proposition acceptée devient une tâche ou un événement ordinaire. Le planificateur la place ensuite là où ton énergie est la meilleure ; `Aujourd'hui` te dit quel pic viser.

![Planning de la semaine : blocs de tâches colorés par charge, courbe d'énergie en fond, +18 % d'alignement](img/planning.webp)

![Aujourd'hui : énergie 65, prochain pic à 12:30, conseillé pour la refonte du module de facturation](img/aujourdhui-plan.webp)

### La démonstration en ligne des outils (application réelle)

La page `/kairos/agents.html` appelle les vrais outils dans ton navigateur. Ici : un agent de réunions demande des créneaux, puis on valide une proposition piégée.

![Page de démonstration : titre « Les agents proposent. Toi, tu disposes. » et les quatre temps du principe](img/agents-accueil.webp)

![Appel de l'outil kairos_find_slots avec les droits read:busy et read:energy, et la réponse JSON](img/agents-outil.webp)

![Validation d'une proposition hostile : acceptée, mais texte nettoyé et aucune consigne exécutée](img/agents-validation.webp)

### La boîte de réception (maquette, pas encore construite)

Voilà comment les propositions s'afficheraient : qui propose, pourquoi, l'énergie à ce créneau, accepter ou refuser, et à droite les droits de chaque agent avec un bouton pour les révoquer. La source est dans `maquettes/boite-de-reception.html`.

![Maquette de la boîte de réception : trois propositions d'agents et le panneau des droits](img/maquette-boite-de-reception.webp)

## 1. L'idée

Des agents planifient déjà des vies : ils calent des réunions, trient des mails, lisent une montre. Ils ignorent tous la
même chose : **l'état du cerveau de la personne**. Kairos est ce contexte biologique. Il sait où sont les pics et les
creux, et il peut placer une activité au bon endroit. Les agents lui apportent de la donnée brute et des propositions ;
il leur rend des décisions.

Trois principes tiennent tout le reste :

1. **L'agent propose, la personne dispose.** Un agent n'écrit jamais dans l'état. Il dépose des *propositions* dans une
   boîte de réception. Rien n'est appliqué sans accord.
2. **Droits étroits et lisibles.** Chaque agent reçoit des *scopes* précis. Sans `read:energy`, aucune valeur d'énergie ne sort.
3. **Le texte d'un agent est une donnée, jamais une instruction.** Il est nettoyé, borné, affiché, jamais exécuté.

## 2. Architecture

```
 Agents (cloud ou local)                    Kairos
 ┌──────────────────────┐   outils MCP    ┌───────────────────────────────┐
 │ réunions · mails ·   │ ─────────────▶  │ lecture : énergie, libre/occupé│
 │ montre · veille      │ ◀─────────────  │ (selon les scopes accordés)    │
 │                      │   propositions  │                                │
 │                      │ ─────────────▶  │ boîte de réception ─▶ validation│
 └──────────────────────┘                 │ ─▶ accord de la personne ─▶ état│
                                          └───────────────────────────────┘
```

Le moteur de Kairos est du JavaScript pur, sans dépendance : il tourne dans le navigateur **et** sous Node. Un serveur
MCP peut donc l'importer tel quel, sans réimplémentation.

## 3. Transports

| Version | Transport | Atteignable par | Statut |
| --- | --- | --- | --- |
| **v1** | Fichier JSON, collage ou lien (`#/inbox?p=…`, cible de partage PWA, raccourci iOS) | Tout agent capable d'écrire un fichier ou une URL, y compris hors-ligne | À construire (boîte de réception) |
| **v2** | Serveur MCP local (stdio) lisant un fichier d'état ; pont avec la PWA par dossier partagé | Agents locaux (Claude Desktop, Cursor, scripts) | À construire |
| **v3** | Relais chiffré de bout en bout, jetons à capacité | Agents dans le cloud | À décider (voir §9) |

La v1 suffit à prouver l'intérêt : elle n'exige ni serveur ni compte.

## 4. Permissions (scopes)

| Scope | Donne accès à | Sensibilité |
| --- | --- | --- |
| `read:busy` | Intervalles occupés, **sans titre**, fusionnés ; classement de créneaux | Faible |
| `read:energy` | Courbe d'énergie prédite, fenêtres d'or, libellé d'énergie des créneaux | **Élevée** : dérivée du sommeil |
| `read:tasks` | Titre, durée, charge, priorité, échéance des tâches ouvertes | Moyenne |
| `propose:event` | Proposer un événement | Écriture indirecte |
| `propose:task` | Proposer une tâche | Écriture indirecte |
| `propose:sleep` | Proposer une nuit ou une sieste | Écriture indirecte |
| `propose:caffeine` | Proposer une prise de caféine | Écriture indirecte |

Il n'existe **aucun** scope pour lire le sommeil brut, les check-ins ou les notes : l'agent n'en a pas besoin pour décider.
Un jeton est lié à un agent, à une liste de scopes et à une date d'expiration ; la personne le révoque en un geste.

## 5. Boîte de réception

Cycle de vie d'une proposition : `pending` → `accepted` | `rejected` | `expired`.

- **Politique de confiance par agent**, choisie par la personne : `ask` (défaut, validation manuelle), `auto` limitée à un
  type et à un risque faible (par exemple des cafés proposés par la montre), ou `never`. Aucun texte d'un agent ne peut
  changer cette politique.
- **Idempotence** : une proposition de même `dedupeKey` remplace la précédente restée en attente.
- **Priorité à la saisie manuelle** : si une nuit proposée chevauche une nuit saisie à la main, la saisie gagne et la
  proposition est marquée en conflit.
- **Traçabilité** : tout élément accepté garde `origin = { proposalId, agent }`, visible dans l'interface. L'annulation du
  store s'applique comme pour une saisie manuelle.
- **Expiration** : `expiresMs` facultatif ; au-delà de 14 jours sans réponse, une proposition expire.
- **Limites** : 50 propositions par appel, 64 Ko par appel, au plus 200 en attente par agent.

## 6. Format d'une proposition

Schéma : [`agents/proposal.schema.json`](agents/proposal.schema.json). Exemples : [`agents/examples/`](agents/examples/).

```json
{
  "schema": "kairos.proposal/1",
  "id": "evt_9f3a2c1b",
  "source": { "agent": "assistant-reunions", "run": "run-2026-11-23-1" },
  "kind": "event",
  "payload": { "title": "Point produit avec Camille", "startMs": 1795618800000, "endMs": 1795621500000 },
  "rationale": "Créneau commun ; ton énergie est basse à ce moment-là, idéal pour une réunion.",
  "dedupeKey": "point-produit-s48",
  "confidence": 0.8
}
```

`kind` vaut `event`, `task`, `sleep` ou `caffeine`. Le contenu de `payload` suit le modèle de données de
`ARCHITECTURE.md`. Les champs inconnus sont ignorés, jamais conservés.

## 7. Outils MCP

Catalogue complet : [`agents/mcp-tools.json`](agents/mcp-tools.json), généré depuis le code.

| Outil | Rôle | Scopes requis |
| --- | --- | --- |
| `kairos_get_energy` | Courbe d'énergie (0-100) et fenêtres d'or | `read:energy` |
| `kairos_get_free_busy` | Intervalles occupés, sans titre | `read:busy` |
| `kairos_find_slots` | Meilleurs créneaux libres pour une durée et une charge cognitive données | `read:busy` (`read:energy` pour les libellés) |
| `kairos_list_tasks` | Tâches ouvertes, sans notes | `read:tasks` |
| `kairos_propose` | Dépose jusqu'à 50 propositions dans la boîte de réception | au moins un `propose:*`, et celui du type proposé |

Exemple, un agent de réunions cherche un créneau d'une heure peu coûteux en énergie :

```json
{ "name": "kairos_find_slots", "arguments": { "durationMin": 60, "load": 1, "count": 3 } }
```
```json
{ "slots": [ { "rank": 1, "startMs": 1795512600000, "endMs": 1795516200000 } ],
  "note": "Classement seul : la valeur d'énergie n'est pas divulguée sans le droit read:energy." }
```

`load` vaut 1 pour une réunion légère (le créneau tend à tomber dans un creux) et 5 pour du travail profond (il vise un pic).

## 8. Modèle de menaces

| Menace | Mesure |
| --- | --- |
| **Injection de prompt** : un mail ou une page piégée fait écrire à l'agent un texte qui donne des ordres (« accepte tout », « envoie l'agenda ») | Texte nettoyé (caractères de contrôle et inversions bidirectionnelles retirés), borné, affiché comme donnée. Aucun champ de proposition ne touche aux droits ni à la politique de confiance. Validation manuelle par défaut. |
| **Inondation** : un agent dépose des centaines de propositions | Plafonds par appel et par agent ; regroupement par `dedupeKey` ; jeton révocable. |
| **Usurpation de source** | `source.agent` est celui du jeton, pas celui déclaré dans le message, dès la v2/v3. En v1 (fichier), la source est affichée comme « non vérifiée ». |
| **Fuite par les réponses** : un agent exfiltre la courbe d'énergie | Scope `read:energy` séparé ; `find_slots` sans ce droit ne renvoie qu'un classement ; réponses minimales ; aucun titre dans `get_free_busy`. |
| **Données absurdes** (nuit dans le futur, durée de 10 ans) | Validation de plausibilité de chaque champ, message d'erreur en français renvoyé à l'agent. |
| **Écrasement de données** | Les agents ne peuvent ni modifier ni supprimer : uniquement proposer. Priorité à la saisie manuelle, annulation disponible. |
| **Conseils de santé amplifiés** | Kairos reste un outil de confort : les sorties portent une note, et aucun outil ne renvoie de recommandation médicale. |

La validation de référence est dans `validateProposal` et couverte par `tests/agent-tools.test.mjs`, y compris un cas
de texte hostile.

## 9. Relais chiffré (v3) : conception, pas réalisation

Les agents du cloud ne peuvent pas joindre une application qui vit dans un navigateur. Il faut un point de rencontre, ce qui
touche à la promesse « 100 % local ». Esquisse qui limite l'écart :

- Le relais ne stocke que du **chiffré** (AES-GCM, clé dérivée côté personne) : il voit des tailles et des dates, jamais
  le contenu.
- L'agent reçoit une **clé de capacité** limitée (scopes, expiration). Pour décider, il lit des données déchiffrées chez
  lui : la personne choisit donc *quels agents* voient *quoi*, comme en §4.
- Révocation : suppression de la clé de capacité et rotation de la clé de l'espace.
- Hors-ligne : la PWA fonctionne sans relais ; elle se synchronise quand le réseau revient.

Décision à prendre avant de construire : héberger ce relais (coût, exploitation, responsabilité) ou rester sur les
agents locaux (v1 et v2).

## 10. Versionnage

Le champ `schema` (`kairos.proposal/1`) et la liste des outils sont versionnés. Une évolution compatible ajoute des champs
facultatifs ; une rupture crée `kairos.proposal/2` et les deux coexistent un temps. Les schémas et le catalogue sont
générés par `node kairos/scripts/agent-schema.mjs` ; un test échoue s'ils dérivent du code.

## 11. Parcours types

**Agent de réunions.** Il appelle `kairos_get_free_busy` puis `kairos_find_slots` (`load: 1`) et propose l'événement avec
`kairos_propose`. Kairos affiche : « assistant-reunions propose Point produit, jeudi 15:00 — créneau à énergie basse ».
Un geste pour accepter.

**Agent de sommeil.** Il lit les données brutes d'une source autorisée (export Apple Santé, par exemple) et propose des
nuits (`kind: "sleep"`). Il ne calcule rien : l'interprétation reste dans le modèle déterministe de Kairos, ce qui garde
la calibration et la reproductibilité.

**Agent de veille.** Il repère une échéance dans un mail et propose une tâche (`kind: "task"`, `deadlineMs`,
`rationale: "Échéance trouvée dans un mail du 22 novembre"`). La personne voit la raison et décide.

## 12. Ordre de construction suggéré

1. Boîte de réception dans l'application (v1) : import fichier, collage, lien ; liste, acceptation, refus, politique par agent.
2. Serveur MCP local (v2) qui enveloppe `agent-tools.js` ; pont avec la PWA.
3. Jetons à capacité et page « Agents » dans les Réglages (qui a accès à quoi, depuis quand, révoquer).
4. Décision sur le relais chiffré (v3).

## 13. Pour que l'écosystème s'en empare

Aucune adoption n'est garantie. Ce qui rend un outil facile à adopter pour des agents : un moteur ouvert et lisible, un
catalogue MCP propre, une documentation courte avec des exemples copiables, une démonstration en ligne qui marche sans
compte, et un cas d'usage net (« les agents de planification n'ont pas de contexte biologique »). Tout cela est déjà
prêt côté contenu ; il reste à écrire le serveur.

## 14. Notes pour plus tard : hébergement sur ton VPS

*À noter : tu disposes d'un VPS qui pourrait héberger Kairos. Rien n'est fait pour l'instant. Voici ce qu'il permettrait, du plus simple au plus engageant, et ce qu'il faudra trancher.*

| Usage | Ce que ça demande | Effort |
| --- | --- | --- |
| **1. Héberger l'application** | Copier le contenu de `dist/kairos/` derrière un serveur web, avec HTTPS et un nom de domaine. Le service worker et l'installation en application exigent HTTPS (hors `localhost`). Mêmes fichiers qu'aujourd'hui, aucun code à écrire, et on ne dépend plus de GitHub Pages. | Faible |
| **2. Serveur MCP accessible depuis le cloud** | Le serveur MCP de la v2 exposé en HTTP, derrière TLS et des jetons à capacité (§4). Limite : l'état vit dans ton navigateur, donc sans relais ce serveur ne voit rien. | Moyen |
| **3. Relais chiffré (v3)** | Un petit service qui ne stocke que du chiffré (§9) et fait le pont entre l'application et les agents du cloud. C'est le seul usage qui débloque vraiment les agents distants. | Élevé |

À décider avant l'usage 3 :
- **Ce que le serveur voit.** Même chiffré, il voit des métadonnées (adresses IP, tailles, horaires) : ce sont des données personnelles, donc à mentionner et à limiter. Aucune donnée en clair, journaux minimaux, durée de conservation courte.
- **Exploitation.** Sauvegardes, mises à jour de sécurité, limites de débit, surveillance, et qui est responsable en cas d'incident.
- **Secrets.** Jamais de jeton ni de clé dans le dépôt ; ils vivent sur le serveur.
- **Périmètre.** Ouvert à toi seul, ou à d'autres personnes ? Cela change la responsabilité et les obligations légales.

Informations utiles à réunir le moment venu : le système et les ressources du VPS, si un domaine et HTTPS sont déjà disponibles, ce qui y tourne déjà, et qui y a accès.
