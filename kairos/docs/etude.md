# Kairos — étude de positionnement

> Document interne pour fondateurs et ingénieurs. Objectif : pouvoir dire « pourquoi cette app est différente » **sans mentir**.
> Rédigé le 22 novembre 2026. Convention : **[V]** = vérifié par recherche web à cette date ; **[NV]** = non vérifié (mémoire, inférence ou sources contradictoires). Les prix bougent vite : tout prix est à revérifier avant publication.

---

## 1. Le problème

### 1.1 Trois coûts distincts

1. **Mauvaise allocation de l'énergie.** On planifie par durée et par échéance, jamais par état du cerveau. Résultat : le travail exigeant tombe dans le creux post-prandial ou en fin de journée, les mails dans le pic. Aucun outil grand public de gestion de tâches ne modélise ce phénomène **[V sur les concurrents, voir §2]**.
2. **Fragmentation.** Gloria Mark (UC Irvine) rapporte que l'attention moyenne sur un écran est passée d'environ 2,5 minutes (2004) à 47 secondes (2020) et que la reprise après interruption peut approcher une demi-heure. Les 47 s sont **[V]** via un entretien (UC Newsroom), pas via un article évalué par les pairs ; le « 23 minutes » circulant partout n'a **pas** été retrouvé : ne pas le citer.
3. **Sommeil insuffisant, macro-économie.** RAND Europe (2016) estime le coût du manque de sommeil à jusqu'à 411 G$/an aux États-Unis (≈ 2,28 % du PIB) **[V, communiqué RAND ; méthode non relue, basée sur enquêtes]**. Ordre de grandeur utile, pas un argument produit.

### 1.2 Vie privée : un problème de données de santé

Horaires de sommeil, caféine, humeur et pics d'énergie sont des **données concernant la santé** : catégorie spéciale de l'article 9 du RGPD, traitement interdit sauf exception (typiquement consentement explicite) **[V, texte via sources de guidance ; vérifier le texte EUR-Lex pour toute citation juridique]**. Une architecture sans serveur évite le problème au lieu de le gérer.

### 1.3 État de la science (honnête)

| Fait | Ce que dit la littérature | Limite |
|---|---|---|
| **Modèle à deux processus** (pression de sommeil S + horloge C) | Cadre conceptuel central en recherche sur le sommeil depuis ~30 ans ; Borbély, Daan, Wirz-Justice, Deboer, *J Sleep Res* 2016 « a reappraisal » **[V]** | Modèle qualitatif robuste ; les paramètres quantitatifs varient selon les individus |
| **Heure du jour et cognition** | Revue Schmidt, Collette, Cajochen, Peigneux (2007) : l'heure modifie attention, fonctions exécutives, mémoire, et l'effet dépend du chronotype **[V]** | Revue de laboratoire, protocoles contrôlés |
| **« Synchrony effect »** | May & Hasher et collègues : la performance est meilleure quand l'heure du test coïncide avec le pic d'éveil de la personne ; l'effet est surtout marqué pour les tâches exigeantes demandant un traitement stratégique **[V]** | Effet de taille modeste, pas universel |
| **Analytique vs créatif** | Les problèmes d'« insight » seraient mieux résolus à contretemps (inhibition plus faible) ; pas d'effet constant sur l'analytique **[V mais prudence]** : l'étude retrouvée est un pilote de 34 personnes | Preuve préliminaire. Kairos ne doit **pas** promettre « créatif = creux » comme un fait établi |
| **Privation chronique de sommeil** | Van Dongen et al., *Sleep* 2003 : 14 jours à 4 h, 6 h ou 8 h au lit ; déficits cognitifs cumulatifs et dose-dépendants ; à 6 h, jusqu'à l'équivalent de 2 nuits blanches ; les sujets sous-estiment leur déficit **[V]** | 6 h = temps passé au lit. Le point clé pour Kairos : **le ressenti sous-estime la dette**, donc le modèle apporte de l'information |
| **Demi-vie de la caféine** | Moyenne ≈ 5 h, plage 1,5 à 9,5 h selon les individus (tabac, contraceptifs oraux, grossesse, génétique) **[V, NCBI Bookshelf / Harvard Nutrition Source]** | Variabilité interindividuelle énorme : justifie le paramètre `caffeineHalfLifeH` ajustable |
| **Chronotype et résultats scolaires** | Les chronotypes tardifs ont en moyenne de moins bonnes notes quand les horaires sont tôt ; une étude néerlandaise (≈ 40 890 notes) trouve que le chronotype pèse plus que la durée de sommeil, et que chronotypes précoces et tardifs performent pareil l'après-midi **[V via synthèse de recherche ; auteurs et revue exacts NV]**. Un essai randomisé argentin (753 élèves) montre un gain quand les horaires s'alignent sur le rythme adolescent **[V via synthèse ; référence exacte à contrôler]** | Corrélations ; l'effet sur un adulte qui planifie librement n'est pas mesuré |

**Ce que la science ne dit pas** : qu'un planificateur d'énergie améliore la productivité réelle des adultes. À notre connaissance (recherche web du 22/11/2026), aucune étude ne le démontre pour ce type d'outil **[NV : absence de preuve trouvée, pas preuve d'absence]**. D'où le pilier « Prouver » (§3).

---

## 2. Paysage concurrentiel

### 2.1 Ce que fait chaque acteur

- **Rise Science** : prédit pics et creux d'énergie, fenêtre mélatonine, dette de sommeil sur 14 nuits ; estime le besoin de sommeil à partir de l'usage du téléphone ; ≈ 69,99 $/an après essai de 7 jours, fonctionne sans objet connecté **[V, source en partie promotionnelle]**. Aucune validation indépendante de l'algorithme trouvée ; un avis d'utilisateur signale l'impossibilité de corriger les pics **[V, anecdotique]**. Ne place pas de tâches.
- **Reclaim.ai** : couche de calendrier (Google Calendar, Outlook) pour focus time, habitudes, pauses, réunions intelligentes ; offre gratuite, payant dès ≈ 10 $/mois **[V]**. Cloud, compte requis (**[NV]** sur le détail du traitement des données). Pas de modèle biologique.
- **Motion** : calendrier qui planifie automatiquement les tâches et se réorganise autour des réunions ; prix cité entre 19 et 29 $/siège/mois selon les sources **[V, sources contradictoires]**. Cloud, aucun modèle biologique.
- **Sunsama** : planification quotidienne guidée, manuelle ; 25 $/mois ou 20 $/mois annuel, sans offre gratuite **[V]**.
- **Akiflow** : agenda + boîte de tâches ; 34 $/mois ou 19 $/mois annuel **[V]**.
- **Structured** : planificateur visuel en frise ; gratuit avec « Pro », prix annuel entre 14,99 et 29,99 $ selon les fiches, achat à vie possible **[V, prix incohérents entre captures]**.
- **Todoist** : gestionnaire de tâches. Aucune recherche faite ici ; fonctionnalités et prix **[NV]**. Pas de modèle biologique à notre connaissance.
- **Oura / Whoop** : « readiness » ou « recovery » 0-100 calculés à partir de sommeil, fréquence cardiaque au repos, HRV, température **[V]** ; Oura ≈ 5,99 $/mois ou 69,99 $/an **[V]**, Whoop cité à ≈ 30 $/mois par une source **[NV]**. Ils mesurent l'état du **corps** pour la veille, ne planifient pas votre journée, et exigent un capteur.
- **Calendly-like** (prise de rendez-vous) : aucune modélisation de l'état cognitif ; non étudié ici **[NV]**.
- **Applis de caféine** : le segment a explosé. Plusieurs applis iOS récentes (HalfCup, CaffSense, Halvo, Caffeine Clock) annoncent une décroissance exponentielle avec demi-vie réglable (HalfCup : 2 à 10 h), certaines **hors-ligne sans compte** (HalfCup, 4,99 $ une fois) **[V, déclarations des éditeurs, non auditées]**. La caféine seule n'est donc **pas** un différenciateur ; l'intégration l'est. Aucune recherche Android.
- **Timeshifter** (jet-lag) : plan circadien personnalisé pour voyages, conçu avec des chercheurs d'après l'éditeur **[V, déclaration]** ; prix contradictoires (≈ 9,99 $ par voyage / 24,99 $ ou 6,99 $/mois – 69,99 $/an selon les pages) **[V, incohérent]**. Ne planifie pas les tâches.

### 2.2 Tableau comparatif honnête

| Outil | Planification auto des tâches | Modèle biologique | Local-first / sans compte | Confidentialité (déclarée) | Prix indicatif |
|---|---|---|---|---|---|
| **Kairos** | Oui (recuit simulé) | Oui (S + C + caféine) | Oui | Aucune donnée ne quitte l'appareil | Gratuit (à décider) |
| Rise | Non | Oui (propriétaire) | Non [NV] | Non vérifié | ≈ 70 $/an |
| Reclaim | Oui (calendrier) | Non | Non (cloud) | Non vérifié | 0 à ≈ 10 $/mois |
| Motion | Oui | Non | Non (cloud) | Non vérifié | ≈ 19-29 $/mois |
| Sunsama | Non (manuel guidé) | Non | Non | Non vérifié | 20-25 $/mois |
| Akiflow | Partielle [NV] | Non | Non | Non vérifié | 19-34 $/mois |
| Structured | Non (frise manuelle) | Non | Partiel [NV] | Non vérifié | ≈ 15-30 $/an |
| Todoist | Non | Non | Non | Non vérifié | NV |
| Oura / Whoop | Non | Non (score physiologique) | Non | Non vérifié | ≈ 70 $/an + capteur ; Whoop NV |
| Applis caféine | Non | Partiel (caféine seule) | Souvent oui | Variable, déclaratif | 0 à 10 $ |
| Timeshifter | Non | Oui (circadien, jet-lag) | Non [NV] | Non vérifié | 7-70 $ selon formule |

### 2.3 La zone blanche, et ses limites

**Zone blanche (à notre connaissance, non exhaustive)** : aucune solution trouvée ne combine (a) un modèle biologique d'énergie, (b) un placement automatique de tâches sur cette courbe, (c) un fonctionnement 100 % local et hors-ligne, et (d) une calibration individuelle auto-validée. Chaque brique existe séparément. Une absence n'est pas une preuve : une revue plus large (Android, outils de niche, recherche académique) reste à faire.

**Faiblesses, à dire sans fard :**
- **Pas de capteur.** Le modèle repose sur ce qu'on déclare (sommeil, caféine) et sur des check-ins subjectifs ; Oura/Whoop ont une donnée physiologique objective que nous n'avons pas.
- **Modèle population + ajustement individuel.** Les paramètres par défaut viennent de moyennes ; l'ajustement par Nelder-Mead exige au moins 8 check-ins et reste bruité (l'alerte déclarée sur 1-5 est une mesure grossière).
- **Validité externe limitée.** Les modèles à deux processus sont validés surtout en laboratoire, sur des cas contrôlés ; la vie réelle (stress, repas, lumière, médicaments) échappe au modèle.
- **Pas de preuve d'impact sur la productivité.** Voir §1.3.
- **Pas de synchronisation multi-appareils** par conception (compromis du local-first).
- **Marque et distribution inexistantes** face à des acteurs financés.

---

## 3. Positionnement et proposition de valeur

**En une phrase :** *Kairos prédit les heures où ton cerveau est le meilleur et y place tes tâches, entièrement sur ton appareil, sans compte.*

### Trois piliers

| Pilier | Promesse | Mécanisme |
|---|---|---|
| **Prédire** | Une courbe d'énergie sur 24 h à 7 jours, avec ses incertitudes affichées | Modèle de Borbély (S + C), inertie du sommeil, caféine en cinétique d'ordre 1 |
| **Placer** | Les tâches exigeantes dans les pics, les routines dans les creux, échéances respectées | Glouton + recuit simulé déterministe, fonction de coût charge cognitive ↔ alerte |
| **Prouver** | Le modèle est confronté à ton ressenti, on te montre l'erreur | Check-ins, validation croisée leave-one-out, graphique prédit vs. ressenti, score de confiance |

### Messages par persona

| Persona | Message | Fonction clé |
|---|---|---|
| **Développeur** | « Tes deux heures de code profond au pic, tes revues de PR dans le creux de 14 h. Et c'est du JavaScript lisible, zéro dépendance. » | Planificateur, `#deep`, export .ics |
| **Étudiant** | « Révise quand tu retiens, pas quand tu culpabilises. Vois ce que coûte une nuit courte avant l'exam. » | Dette de sommeil, simulation « et si », sieste planifiée |
| **Parent actif** | « Des nuits hachées, des journées pleines : trouve les 45 minutes où tu es vraiment là. » | Fenêtres d'or, coupure caféine, siestes courtes |
| **Voyageur fréquent** | « Un plan de lumière et de sommeil pour changer de fuseau, hors-ligne dans l'avion. » | Module jet-lag, fonctionne sans réseau |

### Ce qui est réellement disruptif (et ce qui ne l'est pas)

**Disruptif par la combinaison** : local-first + modèle biologique + planificateur à recuit simulé + personnalisation validée par validation croisée + export chiffré (PBKDF2 + AES-GCM). **Pas disruptif isolément** : la caféine (déjà saturée), le suivi du sommeil, le calendrier intelligent. Dire « la seule app… » est un risque ; dire « nous n'avons pas trouvé d'app qui… » est défendable.

---

## 4. Risques, garde-fous, métriques, feuille de route

### 4.1 Risques et garde-fous

| Risque | Garde-fou |
|---|---|
| **Perçu comme dispositif médical** | Mention explicite « outil de confort, pas un dispositif médical » ; aucune allégation de diagnostic ou de traitement ; pas de conseils sur des médicaments |
| **Biais du modèle** (moyennes de populations occidentales, adultes jeunes ; décalages d'équipes de nuit, adolescents) | Écran « La science » avec limites ; paramètres personnels réglables ; avertissement pour profils hors domaine |
| **Fausse précision** | Afficher des plages et une confiance (0 si moins de 8 check-ins), jamais un chiffre nu ; vocabulaire « probable », pas « sera » |
| **Effet placebo / auto-prophétie** | Le pilier « Prouver » compare prédit et ressenti dans le temps ; ne pas conclure sur 5 jours |
| **RGPD** | Par conception : aucune donnée collectée, pas de serveur, pas de traceur ; export chiffré sous contrôle de l'utilisateur ; suppression = effacer le stockage local |
| **Perte de données** (local-first) | Export chiffré régulier, rappel in-app, import testé |
| **Surpromesse marketing** | Cette étude sert de filtre : toute allégation chiffrée doit figurer comme **[V]** |

### 4.2 Métriques de succès

- **Calibration** : erreur (RMSE) entre énergie prédite et ressentie, avant/après ajustement, médiane sur les utilisateurs ayant ≥ 8 check-ins (calculable **localement** ; un agrégat anonyme serait optionnel et opt-in, ou uniquement via bêta-testeurs volontaires).
- **Rétention** : retour à J7 et J30 (par sondage ou bêta, car aucune télémétrie).
- **Adhérence au plan** : part des blocs planifiés réellement réalisés (sessions de focus enregistrées).
- **Gain perçu** : note de focus moyenne dans les blocs « pic » vs « creux » (donnée déjà dans `FocusSession.rating`) ; c'est la mesure la plus proche d'une preuve interne.
- **Qualité du moteur** : gain du planificateur (`lift`) vs planification naïve, temps < 400 ms.
- **Confiance** : taux de suppression/réinitialisation suite à une prédiction jugée fausse (signal négatif).

### 4.3 Feuille de route à trois horizons

| Horizon | Objectif | Contenu |
|---|---|---|
| **H1 — 0-3 mois : crédibilité** | Rendre la valeur évidente et mesurable | Import CSV (sommeil, caféine), import Apple Santé (export XML), widget d'accueil PWA, écran de calibration affiné, bêta fermée avec protocole de mesure |
| **H2 — 3-9 mois : écosystème local** | Ouvrir sans trahir le local-first | Partage d'agenda chiffré (liens à clé, sans serveur de contenu, ou pair-à-pair), API de plugins (sources de données sandboxées), module « équipe » en lecture seule, traductions |
| **H3 — 9-18 mois : preuve et portée** | Prouver l'effet | Étude pilote (A/B planifié vs naïf, pré-enregistrée), intégrations capteurs via Health Connect / Apple Santé, modèles par profils (travail posté, adolescents) |

### 4.4 Idées « moonshot » plausibles

1. **Étude citoyenne locale** : agrégation anonyme par **calcul fédéré ou différentiel**, opt-in, pour affiner les paramètres de population sans collecter de données brutes.
2. **Co-planification d'équipe sans fuite** : chacun partage uniquement des créneaux « bons pour réunion » dérivés du modèle, jamais l'énergie ni le sommeil.
3. **Modèle personnel portable** : exporter un « profil circadien » chiffré utilisable par d'autres outils via la future API de plugins.
4. **Co-pilote d'équipes de nuit / soignants** : variante validée avec des chronobiologistes pour le travail posté.

---

## 5. Pitch, tagline, idées de fonctionnalités

### Pitch de 30 secondes

> « Tu ne travailles pas pareil à 10 h et à 15 h, mais ton agenda ne le sait pas. Kairos prédit ton énergie à partir de ton sommeil, de ton rythme naturel et de ta caféine, puis range tes tâches là où ton cerveau est au meilleur. Tout reste sur ton téléphone : pas de compte, pas de serveur, ça marche hors-ligne. Et il ne te demande pas de le croire sur parole : il compare ses prédictions à ton ressenti et te montre à quel point il se trompe. Kairos, l'emploi du temps de ton cerveau. »

### Taglines

| FR | EN |
|---|---|
| L'emploi du temps de ton cerveau. | Your brain's schedule. |
| Fais le bon travail au bon moment. | The right work at the right hour. |
| Ton énergie, prédite. Tes tâches, placées. | Your energy, predicted. Your tasks, placed. |
| Planifie avec ton cerveau, pas contre lui. | Plan with your brain, not against it. |
| Le bon moment, c'est maintenant (ou pas). | Find your kairos. |

### Dix fonctionnalités classées impact / effort

| # | Fonctionnalité | Impact | Effort | Note |
|---|---|---|---|---|
| 1 | Import CSV / Apple Santé du sommeil | Élevé | Moyen | Compense l'absence de capteur |
| 2 | Écran « prédit vs ressenti » avec confiance affichée | Élevé | Faible | Cœur du pilier Prouver |
| 3 | Widget / notification « ta prochaine fenêtre d'or » | Élevé | Moyen | Habitude quotidienne |
| 4 | Simulation « et si je dors 1 h de moins / un café à 16 h » | Élevé | Faible | Déjà permis par `whatIf` |
| 5 | Mode « jour de vol » (jet-lag hors-ligne) | Moyen | Faible | Moteur existant |
| 6 | Export .ics des blocs planifiés | Moyen | Faible | Interopérabilité agendas |
| 7 | Sauvegarde chiffrée programmée + rappel | Moyen | Faible | Réduit le risque de perte |
| 8 | Partage d'agenda chiffré | Moyen | Élevé | Lourd à bien faire sans serveur |
| 9 | API de plugins sandboxée | Élevé (long terme) | Élevé | Ouvre l'écosystème |
| 10 | Mode « étude pilote » : protocole A/B guidé | Élevé (crédibilité) | Moyen | Génère la preuve manquante |

**Quick wins** : 2, 4, 5, 6, 7. **Paris structurants** : 1, 9, 10.

---

## Sources

Science
- [Synchrony effect, May & Hasher, revue 2023 (PDF)](https://blogs.cofc.edu/mayc/files/2023/06/May-Hasher-Healey-2023.pdf)
- [APA Monitor, « Good timing » (2018)](https://www.apa.org/monitor/2018/06/good-timing)
- [Schmidt et al. 2007, « A time to think »](https://orbi.uliege.be/handle/2268/4666)
- [Van Dongen et al. 2003, Sleep](https://pubmed.ncbi.nlm.nih.gov/12683469/)
- [Borbély et al. 2016, reappraisal du modèle à deux processus](https://pubmed.ncbi.nlm.nih.gov/26762182/)
- [Demi-vie de la caféine, NCBI Bookshelf](https://www.ncbi.nlm.nih.gov/books/NBK223808/) et [Harvard Nutrition Source](https://nutritionsource.hsph.harvard.edu/food-features/caffeine/)
- [Chronotype et notes scolaires (Sci. Rep. 2017, à vérifier)](https://link.springer.com/10.1038/s41598-017-04076-y) et [horaires scolaires et rythme adolescent (Nat. Hum. Behav. 2020, à vérifier)](https://www.nature.com/articles/s41562-020-0820-2)
- [RAND, coût économique du manque de sommeil](https://www.rand.org/pubs/research_reports/RR1791)
- [UC Newsroom, Gloria Mark sur l'attention](https://www.universityofcalifornia.edu/news/how-sharpen-your-attention-and-meet-your-goals-2024)
- [RGPD article 9, texte et guidance](https://gdpr-info.eu/art-9-gdpr.) ; [ICO, conditions de traitement](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-are-the-conditions-for-processing/)

Marché
- [Rise, avis éditeur](https://www.risescience.com/blog/rise-app-review) ; [Rise, App Store](https://apps.apple.com/us/app/rise-sleep-tracker/id1453884781)
- [Reclaim, alternatives à Motion (source concurrente)](https://reclaim.ai/blog/motion-alternatives) ; [Motion vs Reclaim, Morgen](https://morgen.so/blog-posts/motion-vs-reclaim)
- [Akiflow, tarifs](https://akiflow.com/pricing) ; [Structured, App Store](https://apps.apple.com/app/id1499198946)
- [Timeshifter, tarifs](https://intercom.help/timeshifter/en/articles/3187858-what-is-the-price) ; [Timeshifter, essai](https://timeshifter.com/try)
- [Oura, readiness](https://ouraring.com/readiness/) ; [Oura vs Whoop, Wareable](https://wareable.com/fitness-trackers/hume-band-vs-whoop-vs-oura)
- [HalfCup](https://apps.apple.com/app/id6756392479) ; [CaffSense](https://apps.apple.com/app/id6778919665) ; [Caffeine Clock](https://apps.apple.com/us/app/caffeine-clock/id6504160396)
