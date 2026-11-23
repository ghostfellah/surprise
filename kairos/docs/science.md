# La science de Kairos

Kairos prédit une courbe d'**alerte** (0 à 100) sur ta journée à partir de ton sommeil, de ton rythme circadien
et de ta caféine, puis s'en sert pour placer tes tâches. Ce document explique **ce qui est dans le modèle, d'où
viennent les chiffres et jusqu'où on peut lui faire confiance**. Il est écrit pour être lu, y compris par un
sceptique : chaque paramètre est classé *mesuré dans la littérature*, *ordre de grandeur de la littérature* ou
*choix de modélisation* (le plus honnête des trois quand on n'a pas de mesure).

> Kairos est un outil de confort et d'organisation, **pas un dispositif médical**. Il ne diagnostique rien,
> ne remplace pas un avis médical et ne doit pas servir à décider de conduire ou d'opérer une machine en étant fatigué.

**Statut de vérification.** Les valeurs ci-dessous viennent de la littérature telle que je la connais. Lors de la
construction du moteur, deux points seulement ont été revérifiés en ligne (recherche web) : (1) la courbe de
réponse de phase de Khalsa et al. (2003) est de « type 1 » — retard si la lumière précède le minimum de
température centrale, avance si elle le suit — avec une amplitude pic-à-creux de ≈ 5 h pour 6,7 h de lumière
vive ; (2) les plans de voyage d'Eastman & Burgess supposent ≈ 1,5 h/jour d'avance et ≈ 2 h/jour de retard avec de
la lumière bien placée, et leurs mesures de laboratoire donnent ≈ 1,6 h/j (avance) et ≈ 2,4 h/j (retard). Tout le
reste est cité de mémoire : les références sont réelles, mais les valeurs numériques exactes sont à revérifier
avant toute publication scientifique.

---

## 1. Le modèle en une page

```
alerte(t) = base + wC·C(t) − wS·S(t) − creux_post-prandial(t) − pénalité_dette − inertie(t)   (+ caféine)
              puis ramenée dans 0..100 (saturation douce vers 100)
```

- **S(t)** — la *pression de sommeil* (processus homéostatique) : elle monte quand tu es éveillé, redescend quand tu dors.
- **C(t)** — la *composante circadienne* : l'horloge interne de ≈ 24 h, indépendante du temps passé éveillé.
- **inertie(t)** — l'« ivresse du réveil » : la brume des 15 à 60 premières minutes.
- **creux post-prandial** — la baisse d'alerte de début d'après-midi, présente même sans repas.
- **pénalité de dette** — l'effet d'un manque de sommeil accumulé sur plusieurs jours.
- **caféine** — un coup de pouce temporaire qui masque une partie de la pression de sommeil.

C'est l'idée du **modèle à trois processus de l'alerte** (Åkerstedt & Folkard 1995) : S + C + W (inertie).

---

## 2. Les paramètres, un par un

### 2.1 Processus S (Borbély)

| Paramètre | Valeur | Statut | Source |
|---|---|---|---|
| Constante de montée de S en veille, τi | 18,2 h | mesuré (ajustement sur EEG) | Achermann, Dijk, Brunner & Borbély 1993 ; Borbély & Achermann 1999 |
| Constante de décroissance de S en sommeil, τd | 4,2 h | mesuré | idem |
| Forme | exponentielle, asymptotes 1 (veille) et 0 (sommeil) | modèle | Borbély 1982 ; Daan, Beersma & Borbély 1984 |
| Échelle par le besoin de sommeil k = besoin / 8 h | τi/k, τd·k | choix de modélisation | — |
| S initial avant échauffement | 0,35 | arbitraire, oublié en ≈ 3 jours | — |
| Jours d'échauffement avant `fromMs` | 6 | choix | — |

La solution est **analytique par morceaux** (pas d'intégration numérique) : la valeur est exacte quel que soit le pas.
L'échelle par le besoin de sommeil a une propriété voulue : dormir exactement ton besoin dissipe toujours la même
fraction de S, quel que soit ce besoin — c'est la définition opérationnelle d'un « besoin » ici.

### 2.2 Composante circadienne C

C est la somme d'une harmonique de 24 h et d'une 2ᵉ harmonique de 12 h, normalisée dans [−1, 1] (Borbély 1982 ;
Dijk & Czeisler 1995 pour la structure circadienne de la vigilance).

- **Période : 24 h exactement.** On suppose l'horloge calée sur le jour (cas d'un sujet entraîné). La période
  intrinsèque humaine est ≈ 24,2 h (Czeisler et al. 1999) ; l'entraînement quotidien la ramène à 24 h.
- **Ancrage de phase.** Le minimum de température centrale (CBTmin) survient ≈ 2 à 3 h avant le réveil habituel
  (Burgess & Eastman ; Roenneberg). On pose : `CBTmin = réveil − 0,5 h − durée du sommeil / 4`, soit « réveil − 2,5 h »
  pour 8 h de sommeil.
- **Suivi des horaires réels.** La phase est mise à jour à chaque réveil « de nuit » (≥ 3 h) : elle rattrape 45 % de
  l'écart à l'horaire observé, **au plus 1 h par jour** (ordre de grandeur de ce qu'une horloge peut décaler
  spontanément : Revell & Eastman 2005 ; Eastman & Burgess 2009), puis est interpolée linéairement. Résultat :
  une série de grasses matinées décale la courbe ; un seul week-end la fait glisser d'environ 1 h (le « jet-lag social »
  de Roenneberg 2003).
- **Formes (choix de modélisation).** Acrophase de l'harmonique 24 h : 11,6 h après le CBTmin ; 2ᵉ harmonique
  d'amplitude relative 0,47, pic 5 h après le CBTmin (matin et soirée) ; elle produit le pic de fin de matinée, le
  creux d'après-midi et le « second souffle » du début de soirée (la « zone de maintien de l'éveil » avant la montée de
  mélatonine : Strogatz et al. 1987, Lavie 1986).

### 2.3 Inertie du sommeil W

Décroissance exponentielle après chaque réveil (Tassi & Muzet 2000 ; Åkerstedt & Folkard 1995).

| Élément | Valeur | Statut |
|---|---|---|
| Amplitude de base | 15 points d'alerte × « profondeur » du sommeil | choix |
| Constante de temps | 0,45 à 1,0 h selon la profondeur | ordre de grandeur (l'inertie dure 15–60 min, parfois plus) |
| Profondeur, nuit (≥ 3,5 h) | 0,75 à 1 selon la pression de sommeil au coucher | choix |
| Profondeur, sieste | ≈ 0,1 sous 12 min, croît jusqu'à 1 vers 60 min | cohérent avec : pas de sommeil lent en sieste courte (Brooks & Lack 2006 ; Hilditch et al. 2016) |
| Surplus si réveil au creux circadien | jusqu'à +40 % | cohérent avec Dijk & Czeisler |
| Rampes | 8 min après le réveil, 20 min avant l'endormissement | cosmétique : lisser la courbe |

### 2.4 Creux post-prandial

Composante circasemidienne (période 12 h) documentée par Monk (2005) : la somnolence présente un pic en début
d'après-midi **même sans déjeuner**. Modélisé par une gaussienne centrée 9,5 h après le CBTmin (≈ 14 h) de largeur 1,1 h
et de profondeur 7 points, **en plus** de la 2ᵉ harmonique. Amplitude *modeste*, choisie à l'œil pour que le creux
mesuré par le modèle (≈ 15 points sous le pic du matin) reste raisonnable.

### 2.5 Dette de sommeil

- Fenêtre de 14 jours ; poids `exp(−âge / 7 j)` (les nuits récentes comptent davantage) ; un excédent n'efface que la
  moitié d'un déficit équivalent (on ne « stocke » pas vraiment le sommeil : Kitamura et al. 2016 montrent un
  bénéfice partiel du rattrapage).
- Le déficit est calculé par rapport à `profile.sleepNeedH`. Les nuits sans journal sont **supposées** conformes à
  l'horaire habituel (si ton horaire habituel est plus court que ton besoin, tu auras donc une dette « de fond »).
- Effet sur l'alerte : pénalité saturante `11 · (1 − exp(−dette/8))` points. Elle s'ajoute à l'effet de S parce que
  les restrictions chroniques font chuter la vigilance plus que S seul ne le prédit (Van Dongen et al. 2003 : deux
  semaines à 6 h/nuit ≈ une nuit blanche sur les tests de vigilance, **sans que les sujets s'en rendent compte**).
  Les 11 points maximum sont un choix.

### 2.6 Caféine

| Élément | Valeur | Statut | Source |
|---|---|---|---|
| Absorption/élimination | ordre 1, `A(t) = D·ka/(ka−ke)·(e^{−ke t} − e^{−ka t})` | modèle | pharmacocinétique classique |
| Pic de concentration (tmax) | ≈ 40 min (ka calculé pour l'obtenir) | ordre de grandeur (30–60 min) | Blanchard & Sawers 1983 ; Fredholm et al. 1999 |
| Demi-vie | 5 h par défaut, 2–12 h permises (3–9 h typiques) | mesuré en population, **très variable** | Nehlig 2018 (CYP1A2, tabac, contraceptifs oraux, grossesse…) |
| Biodisponibilité | 100 % | simplification | — |
| Effet | antagonisme de l'adénosine ⇒ comme si S était réduit | mécanisme établi | Fredholm 1999 ; Porkka-Heiskanen & Kalinchuk 2011 |
| Courbe dose-effet | `16 · m/(70 + m)` points, m = mg × sensibilité | **choix** (saturante) | ordres de grandeur : Smith 2002 ; Lieberman 2002 |
| Dépendance à la fatigue | × (0,55 + 1,3·S) | choix cohérent avec l'observation que l'effet est plus net quand on est fatigué | Smith 2002 |
| Tasse de référence | 80 mg | usuel (café filtre 80–100 mg) | — |
| Seuil au coucher | 25 mg restants | **choix prudent** | Drake et al. 2013 (400 mg 6 h avant le coucher : −1 h de sommeil) |
| Plafond conseillé | 400 mg/jour (repère, non appliqué strictement) | repère officiel | EFSA 2015 |

**Coupure.** `caffeineCutoff` donne l'heure la plus tardive à laquelle une tasse de 80 mg laisse ≤ 25 mg dans le
sang au coucher, compte tenu de ce que tu as déjà bu. Avec 5 h de demi-vie et un coucher à 23 h, c'est ≈ 14 h 30.

**Suggestions.** `suggestCaffeine` choisit (jusqu'à 3 prises, espacées d'au moins 3 h) les instants qui maximisent
le gain d'alerte là où l'alerte de base est basse, sous la contrainte du seuil au coucher. Sur l'idée populaire
d'**attendre 60 à 90 min après le réveil** (pic de cortisol du réveil) : elle est **faiblement étayée** (peu d'essais
contrôlés, et l'inertie du sommeil est réelle). Kairos applique seulement un léger malus (−15 %) à cette plage et
le dit dans l'explication — jamais une interdiction.

### 2.7 Mélatonine, DLMO et fenêtre de « wind-down »

- **DLMO** (début de la sécrétion de mélatonine en lumière faible) estimé à **CBTmin − 7,5 h**, soit ≈ 2 à 3 h avant
  un coucher habituel. L'intervalle DLMO → CBTmin est typiquement de 6 à 8 h selon les études (Burgess & Eastman ;
  Benloucif et al. 2005) : l'incertitude individuelle est de l'ordre de ± 1 h.
- **Zone « mélatonine »** : du DLMO au coucher. **Zone « wind-down »** : les 90 min avant le coucher (lumière
  douce, écrans en pause). Ces durées sont des conseils d'hygiène de sommeil courants, pas des seuils mesurés.
- Kairos ne propose **aucune** prise de mélatonine (voir §2.10).

### 2.8 Chronotype (MSFsc, Roenneberg)

- Milieu de sommeil des **jours libres** (réveil un jour non travaillé), corrigé du sommeil rattrapé :
  `MSFsc = MSF − 0,5·(SDf − SDsemaine)` si on dort plus long les jours libres (Roenneberg, Wirz-Justice & Merrow 2003 ;
  Roenneberg et al. 2004).
- Étiquettes : **alouette** si MSFsc < 3 h 30 ; **chouette** si ≥ 5 h 15 ; **intermédiaire** sinon. La moyenne
  européenne se situe vers 4 h–4 h 30 ; ces seuils sont un découpage pratique, pas une classification clinique.
- **Confiance** : `1 − exp(−n/12)` selon le nombre de nuits, divisée par 2 sans aucun jour libre observé, × 0,75 sans
  jour travaillé. À 3 nuits la confiance est faible ; à 20 nuits mixtes elle dépasse 0,8.

### 2.9 Coucher en cycles de 90 min et sieste

- **Cycles** : ≈ 90 min (la durée varie de 70 à 120 min selon la nuit et la personne), latence d'endormissement 15 min.
  `suggestBedtime` choisit 4 à 7 cycles, le plus proche de ton besoin. Se réveiller en fin de cycle limite
  l'inertie, **mais l'effet est modeste** : la durée totale compte plus que la « bonne » minute. Recommandations de
  durée : Hirshkowitz et al. 2015 (National Sleep Foundation).
- **Sieste** (`planNap`) : 20 min (évite le sommeil lent donc l'inertie : Brooks & Lack 2006 ; Hilditch et al. 2016),
  placée dans le creux d'alerte prévu, commençant au moins 4 h après le réveil et **au moins 8 h avant le coucher**
  pour ne pas amputer la pression de sommeil de la nuit. 90 min (un cycle complet) seulement si la dette dépasse 3 h.
  Aucune sieste n'est proposée si l'alerte reste haute et la dette faible.

### 2.10 Décalage horaire (`jetlag.js`)

- **Principe** : la lumière est le synchroniseur dominant. Lumière **avant** le CBTmin ⇒ retard ; **après** ⇒ avance
  (Khalsa et al. 2003 ; Minors, Waterhouse & Wirz-Justice 1991 ; Revell & Eastman 2005).
- **PRC utilisée** : deux gaussiennes (retard centré 4 h avant CBTmin, avance 4 h après). **Seule l'orientation est
  solidement établie** ; la forme précise et les amplitudes varient selon les individus, l'intensité et la durée
  de la lumière.
- **Fenêtres.** Avance : lumière entre CBTmin + 1 h et + 4 h, lumière à éviter entre − 5 h et + 1 h. Retard : lumière
  entre − 5 h et − 2 h, à éviter entre CBTmin et + 5 h. Le plan recalcule le CBTmin du corps chaque jour (en heure
  de destination), ce qui gère automatiquement le piège du « mauvais sens » pour les grands décalages vers l'est.
- **Vitesse** : 0,85 h/jour en avance, 1,0 h/jour en retard (réaliste, sans protocole de laboratoire) ; au moins 25 %
  du rythme même quand les fenêtres sont mal placées (cycle jour/nuit local, horaires de repas, vie sociale).
  Les maxima de laboratoire sont plus élevés (voir « Statut de vérification »).
- **Choix du sens** : on compare `avance/0,85` et `(24 − avance)/1,0` jours et on garde le plus court ; l'autre option
  est affichée. Cela donne « avancer » jusqu'à ≈ 11 h vers l'est, « retarder » au-delà.
- **Anticipation** : 2 jours avant le départ (si le décalage dépasse 3 h), à 75 % du rythme normal.
- **Médicaments** : Kairos n'en recommande aucun. La mélatonine est mentionnée uniquement comme *« à discuter avec un
  professionnel de santé »*. Règle de pouce de « un jour par heure de décalage » : Waterhouse et al. 2007.

---

## 3. Comment le modèle est personnalisé

Tout ce qui suit change réellement les courbes :

1. **Tes journaux de sommeil.** Ils sont la vérité pour le passé ; les nuits non renseignées sont supposées
   conformes à `usualBed/usualWake`. Ils pilotent S, la dette, l'inertie et la **phase** de C.
2. **`sleepNeedH`** (besoin de sommeil) : met à l'échelle S (τi/k, τd·k) et fixe la dette.
3. **`usualBed` / `usualWake`** : le futur (sommeil supposé), l'ancrage initial de la phase, le DLMO.
4. **`chronoShiftMin`** : décale la courbe C par rapport à ton sommeil (si ton corps est « plus tard » ou
   « plus tôt » que ton horaire). C'est le paramètre qui sépare un vrai chronotype tardif d'une simple habitude.
5. **`caffeineSensitivity`** (0,4–2 en pratique) : multiplie l'effet de la caféine. **`caffeineHalfLifeH`** (3–9 h) :
   vitesse d'élimination, donc coupure et reste au coucher.
6. **Ajustement par check-ins** (`personalize.js`) : en répondant « comment te sens-tu ? » (1–5), tu fournis des
   points de comparaison ; un ajustement borné (Nelder-Mead, validation croisée *leave-one-out*) peut moduler
   `chronoShiftMin`, `caffeineSensitivity`, `sleepNeedH`… Il **refuse de conclure sous 8 observations** et expose sa
   confiance, son RMSE et le gain par rapport à une prédiction constante. Toute la personnalisation reste locale.

Ce qui n'est **pas** personnalisé aujourd'hui : les poids relatifs de S, de C, de l'inertie et du creux (identiques
pour tout le monde), la forme de la PRC, l'amplitude de la tolérance à la caféine.

---

## 4. Limites et honnêteté

1. **Les poids du modèle ne sont pas des mesures.** La forme d'une journée type (réveil modeste, pic vers 10–11 h,
   creux vers 14–15 h, second souffle vers 19–20 h, chute au coucher) est qualitative et bien documentée ; les amplitudes
   relatives (`base`, `wC`, `wS`, profondeur du creux) ont été **ajustées sur une courbe cible dessinée à la main**
   (RMSE ≈ 1,4 point sur 12 repères), pas sur un jeu de données. Elles se calibrent individuellement avec les check-ins.
2. **L'alerte est subjective et multidimensionnelle.** Vigilance, humeur, créativité et mémoire n'ont pas toutes le
   même rythme. Kairos modélise une alerte « générale », proche de la vigilance/somnolence subjective ; le travail
   créatif peut mieux se faire hors des pics (certaines études sur l'effet « heure non optimale »).
3. **Entraînement circadien simplifié.** Une seule phase, entraînée par tes réveils ; pas de modèle de lumière
   (l'exposition réelle, les écrans, l'extérieur ne sont pas connus). Pas de saisonnalité, pas de cycle menstruel,
   pas de maladie, de stress, d'alcool, d'exercice, de repas.
4. **Caféine.** Pas de modèle de tolérance (une consommation quotidienne atténue l'effet) ni de « rebond » à
   l'élimination ; pas d'effet de la caféine sur la qualité du sommeil suivant (seulement le reste au coucher et la
   coupure) ; pas de différence entre café, thé, boissons énergisantes (la L-théanine et les autres composés sont ignorés).
   L'effet maximal de 16 points et l'EC50 de 70 mg sont des choix.
5. **Sommeil.** On ne connaît ni les stades, ni les réveils nocturnes ; la qualité (1–5) n'entre pas dans le modèle. Les
   nuits non renseignées sont des hypothèses (ce qui peut surévaluer ou sous-évaluer l'état réel).
6. **Dette de sommeil.** La pondération exponentielle et le crédit de 50 % sont des conventions de calcul ; la science
   de la « récupération » est incomplète. La pénalité de dette est un choix inspiré de Van Dongen et al. (2003).
7. **« Attendre 90 min avant le café »** est faiblement étayé (voir §2.6). **« Réveil en fin de cycle »** a un effet
   modeste (voir §2.9).
8. **Décalage horaire.** Le plan suppose que tu suis les fenêtres de lumière (dehors, même nuageux ≈ 1 000 lx ou plus,
   contre 100–500 lx dans un bureau) ; avec de mauvaises conditions (hiver nordique, avion, travail en intérieur) la
   vitesse sera plus lente. Il ne tient pas compte des escales, des siestes dans l'avion ni de la mélatonine.
9. **Ni diagnostic ni médecine.** Si tu dors mal durablement, as de la somnolence dangereuse, des ronflements
   importants avec pauses respiratoires, ou des difficultés à fonctionner, parles-en à un professionnel de santé.
10. **Les prédictions sont des tendances.** L'incertitude d'un tel modèle sur un individu est de plusieurs points
    d'alerte et d'environ ± 1 h sur l'heure des pics et des creux. Kairos affiche donc des **fenêtres** (« prime
    time »), pas des instants.

---

## 5. Références

- Åkerstedt T, Folkard S (1995). Validation of the S and C components of the three-process model of alertness regulation. *Sleep* 18:1–6.
- Achermann P, Dijk DJ, Brunner DP, Borbély AA (1993). A model of human sleep homeostasis based on EEG slow-wave activity. *Brain Res Bull* 31:97–113.
- Benloucif S et al. (2005). Stability of melatonin and temperature as circadian phase markers. *J Biol Rhythms* 20:178–188.
- Blanchard J, Sawers SJ (1983). The absolute bioavailability of caffeine in man. *J Pharmacokinet Biopharm* 11:109–126.
- Borbély AA (1982). A two process model of sleep regulation. *Hum Neurobiol* 1:195–204.
- Borbély AA, Achermann P (1999). Sleep homeostasis and models of sleep regulation. *J Biol Rhythms* 14:559–570.
- Brooks A, Lack L (2006). A brief afternoon nap following nocturnal sleep restriction. *Sleep* 29:831–840.
- Czeisler CA et al. (1999). Stability, precision, and near-24-hour period of the human circadian pacemaker. *Science* 284:2177–2181.
- Daan S, Beersma DGM, Borbély AA (1984). Timing of human sleep: recovery process gated by a circadian pacemaker. *Am J Physiol* 246:R161–R183.
- Dijk DJ, Czeisler CA (1995). Contribution of the circadian pacemaker and the sleep homeostat to sleep propensity, sleep structure, EEG slow waves and sleep spindles in humans. *J Neurosci* 15:3526–3538.
- Drake C, Roehrs T, Shambroom J, Roth T (2013). Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed. *J Clin Sleep Med* 9:1195–1200.
- Eastman CI, Burgess HJ (2009). How to travel the world without jet lag. *Sleep Med Clin* 4:241–255.
- EFSA (2015). Scientific opinion on the safety of caffeine. *EFSA Journal* 13:4102.
- Fredholm BB et al. (1999). Actions of caffeine in the brain with special reference to factors that contribute to its widespread use. *Pharmacol Rev* 51:83–133.
- Hilditch CJ, Dorrian J, Banks S (2016). A review of short naps and sleep inertia. *Sleep Med* 25:157–165.
- Hirshkowitz M et al. (2015). National Sleep Foundation's sleep time duration recommendations. *Sleep Health* 1:40–43.
- Khalsa SBS, Jewett ME, Cajochen C, Czeisler CA (2003). A phase response curve to single bright light pulses in human subjects. *J Physiol* 549:945–952.
- Kitamura S et al. (2016). Estimating individual optimal sleep duration and potential sleep debt. *Sci Rep* 6:35812.
- Lieberman HR et al. (2002). Effects of caffeine, sleep loss, and stress on cognitive performance and mood during U.S. Navy SEAL training. *Psychopharmacology* 164:250–261.
- Minors DS, Waterhouse JM, Wirz-Justice A (1991). A human phase-response curve to light. *Neurosci Lett* 133:36–40.
- Monk TH (2005). The post-lunch dip in performance. *Clin Sports Med* 24:e15–e23.
- Nehlig A (2018). Interindividual differences in caffeine metabolism and factors driving caffeine consumption. *Pharmacol Rev* 70:384–411.
- Porkka-Heiskanen T, Kalinchuk AV (2011). Adenosine, energy metabolism and sleep homeostasis. *Sleep Med Rev* 15:123–135.
- Revell VL, Eastman CI (2005). How to trick mother nature into letting you fly around or stay up all night. *J Biol Rhythms* 20:353–365.
- Roenneberg T, Wirz-Justice A, Merrow M (2003). Life between clocks: daily temporal patterns of human chronotypes. *J Biol Rhythms* 18:80–90.
- Roenneberg T et al. (2004). A marker for the end of adolescence. *Curr Biol* 14:R1038–R1039.
- Smith A (2002). Effects of caffeine on human behavior. *Food Chem Toxicol* 40:1243–1255.
- Strogatz SH, Kronauer RE, Czeisler CA (1987). Circadian pacemaker interferes with sleep onset at specific times each day. *Am J Physiol* 253:R172–R178.
- Tassi P, Muzet A (2000). Sleep inertia. *Sleep Med Rev* 4:341–353.
- Van Dongen HPA, Maislin G, Mullington JM, Dinges DF (2003). The cumulative cost of additional wakefulness. *Sleep* 26:117–126.
- Waterhouse J, Reilly T, Atkinson G, Edwards B (2007). Jet lag: trends and coping strategies. *Lancet* 369:1117–1129.
