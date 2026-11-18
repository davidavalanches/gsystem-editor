# Refonte UI de G-System Editor : passation

Document de reprise pour une nouvelle session (autre compte, autre outil). Il résume les décisions prises,
l'état du code et les étapes restantes. Les maquettes d'origine sont un canevas de design privé
à l'autre compte ; tout ce qu'il faut pour coder est décrit ici.

## État actuel

- Branches : `refonte-ui-etape-1` (étape 1), puis `refonte-ui-etape-2` (étape 2, commit `a7d109f`), toutes deux
  poussées sur GitHub. Rien n'est fusionné dans `main`, qui reste en version 1.0.5.
- Étape 1 faite : palette sombre unique, Inter, libellés en casse normale, switch d'un bloc = carré avec son
  icône (plein de la couleur du bloc quand il est allumé, variables `--h` et `--t`), matériel allumé en corail
  `--rig`, sélection en contour `--ink`, ambre réservé à « pas encore enregistré ». `.nvmrc` (22) et
  `engines.node >= 22`. Cet aspect est devenu le **thème Modern** (voir étape 2).
- Étape 2 faite (détail plus bas) : vue Preset en chaîne du signal sur ordinateur, grille gardée sur téléphone,
  relais et modificateurs plus accessibles, vue Switches réaliste, et deux thèmes : **Modern** et **Old school**.
- Vérifié : typecheck, 76 tests, build, captures en 740×360 et 1920×1080 (Playwright). APK de test :
  `~/Documents/G-System/gsystem-editor-refonte-etape2.apk` sur la machine de l'utilisateur.
- **Pas encore essayé sur la console** (Retroid Pocket Flip 2, Android 13) : toute l'étape 2, et la teinte des
  blocs allumés de l'étape 1.

## Décisions de design (validées par l'utilisateur)

**Chaîne du signal, fixe sur le G-System :**
Entrée → Filter → Comp → Loop 1, Loop 2, Loop 3, Loop 4, Insert → Gate → EQ → [Mod, Pitch, Delay, Reverb] → Sortie.
Gate et EQ se placent après la dernière boucle physique (le gate ne coupe pas les queues de delay et reverb).

**Routing : il ne touche que Mod, Pitch, Delay et Reverb.**
- Série : les quatre en ligne.
- Parallèle : le même signal entre dans les quatre, empilés sur quatre voies entre un point de séparation et de retour.
- Semi-parallèle : Mod puis Pitch en série, puis Delay et Reverb en parallèle.
- Série 2 : Pitch → Delay → Reverb, avec Mod placé dans la boucle de retour du delay (schéma validé).

**Couleurs (fond sombre) :**
| Rôle | Valeur |
| --- | --- |
| Fond / barre | `#1a1d22` / `#14171b` |
| Surface / surélevé | `#22262c` / `#2b3038` |
| Texte, sélection | `#e9ecf0` |
| Texte secondaire | `#9aa3ad` (≥ 4,5:1) |
| Matériel allumé (`--rig`) | `#ff6b5b`, texte sombre `#14171b` dessus |
| Non enregistré | `#f0b43c` |
| LED de tempo | `#4cc38a` |
| Filter / Comp, Gate / EQ | `#ee6f9f` / `#43c0a8` / `#c4cad3` |
| Mod / Pitch / Delay / Reverb | `#4f9df5` / `#a58bf5` / `#8ccf55` / `#3fc6e0` |

**Gestes :**
- Chaque tuile a deux zones : l'icône allume ou éteint, le nom choisit le bloc et montre ses réglages.
- Appui long ou clic droit : menu du bloc (favoris, modificateur, renommer une loop).
- Banques : **l'échange de banques entières est le geste principal** (glisser le numéro d'une banque sur une
  autre sur ordinateur ; sur téléphone, appui long sur le numéro puis toucher la banque d'arrivée, avec un
  bandeau qui dit quoi faire). L'échange de deux presets reste possible, en second.
- Pas de glisser au doigt sur téléphone (trop imprécis sur 5 pouces).

**Thèmes (étape 2) :** l'utilisateur choisit dans Banques → « More actions » (⋮) → **Appearance…** ; le choix
est gardé sur l'appareil (`localStorage`, clé `gsystem-editor.theme`).
- **Modern** (par défaut) : l'aspect de l'étape 1, police Inter.
- **Old school** : l'aspect des versions 1.0.x, dans les trois finitions du G-System (Black, Grey ou Red brushed) :
  polices IBM Plex Sans et Mono, Michroma, VT323 (écran LCD, toujours en graisse normale : elle n'a qu'une
  graisse), Doto ; écran LCD vert du preset (nom, ligne d'état, tempo), numéro en points rouges, switches
  chromés à base rouge allumée, panneaux brossés, rouge comme seule couleur « allumé ».
- **La disposition est la même dans les deux thèmes.** Exception voulue : pas de pastille sur les loops, même
  en Old school (les libellés gardent la place) ; une loop allumée est remplie.

**Téléphone (décidé à l'étape 2, après essai) :** la chaîne du signal en une rangée ne marchait pas sur 5 pouces
(on confondait bloc choisi et routing). On garde la **grille 2 × 5** (8 blocs, puis Modifiers et Routing), en
tuiles aux coins arrondis espacées de 5 px. Un accordéon (grille plein écran qui se replie quand on ouvre un
bloc) a été maquetté puis écarté : il ajoute une action pour voir les réglages.

**Cibles :** écran d'ordinateur (maquettes en 1920×1080) et téléphone Android 5 pouces en paysage (740×360 dp).
Zones de toucher d'au moins 44 px.

## Prochaines étapes

Chaque étape = une version à essayer sur le téléphone avant la suivante.

### Étape 2 : vue Preset (faite, branche `refonte-ui-etape-2`)

Ce qui est en place :

1. **Ordinateur, chaîne du signal** : In, Filter, Comp, bloc Loops (L1 à L4 et Insert empilés avec les noms de
   `LoopNames`, appui long ou clic droit pour nommer), Gate, EQ, groupe routé, Out. Tuiles de 136 × 62 px
   (élargies depuis 128 pour que « Percussive » tienne), icône de 52 px à gauche.
2. **Groupe routé** encadré en pointillés, redessiné selon le routing : Serial en ligne, Parallel sur 4 voies,
   Semi Parallel (Delay et Reverb en parallèle), Serial2 (Mod dans la boucle de retour du Delay). Sélecteur
   segmenté avec `routingIcon()` dans son en-tête ; dessin ajouté pour Serial2.
3. **Ordinateur, colonne de droite** : les 5 presets de la banque avec 8 pastilles des blocs allumés (un preset
   pas encore lu s'affiche « Not read yet » et ne s'ouvre pas), Relay et boost (bouton Edit → panneau Relays),
   Modifiers (chaque affectation ouvre directement son réglage), Outputs et NovaDrive. La liste des banques
   avec recherche reste à gauche.
4. **Téléphone** : grille 2 × 5 (voir Décisions), puis la bande L1 à L4, INS, **Relay** et Boost. Relay
   fonctionne comme Boost : la lettre (A ou B) bascule le relais, le libellé (contacts fermés) ouvre le panneau
   **Relays** (contacts des réglages A et B, retirés du panneau Routing).
5. **Éditeur du bloc** : icône, nom, type, On/Off, 4 favoris, lecture Mix/Output ; potards et curseurs à la
   couleur du bloc ; badge EXP / ENC / VOL sur un réglage piloté, et sa course (Min → Max) en pointillés sur le
   curseur fin. Menu d'appui long d'un bloc : allumer/éteindre, favoris, modificateurs.
6. **En-tête** : numéro, nom (s'arrête avant le chevron, avec points de suspension ; plus de ligne d'état en
   Modern), point ambre « Modified », LED de tempo et BPM, **Tap** (ordinateur seulement : pas la place sur
   téléphone), Live, Annuler / Rétablir (appui long sur Annuler : retour au preset enregistré), Compare
   (ordinateur), « Store in 07-3 » (« Store » sur téléphone).
7. **Vue Switches** : switches chromés et écran vert du pédalier rétablis (dans les deux thèmes).

Fichiers : `web/src/ui/preset.ts` (disposition selon `DESKTOP`, chaîne, grille, panneaux), `web/src/ui/theme.ts`,
`web/src/themes/oldschool.css` (partie 1 : règles de la 1.0.5 limitées aux couleurs, fonds, ombres et polices,
générées depuis l'ancienne feuille ; partie 2 : écrite à la main pour la nouvelle disposition),
`web/src/ui/widgets.ts` (chiffres en points pour Old school, icônes redo et Serial2).

Restes et points ouverts :
- `docs/refonte-ui/maquette-accordeon.html` : maquette non suivie par git, à supprimer (sinon publiée avec
  `docs/`).
- L'APK passe de 5,3 à 6,3 Mo à cause des polices Old school.
- Non vérifié en captures : la finition Red brushed, et les vues Settings et MIDI en Old school.

### Étape 3 : vue Banques

À faire dans les deux thèmes (Modern et Old school), en gardant la même disposition ; sur téléphone, partir
de ce qui marche aujourd'hui et faire essayer avant d'aller plus loin (leçon de l'étape 2).

1. Ordinateur : 40 lignes, une par banque, de 5 cases ; chaque case = nom, pastilles des blocs allumés, tempo.
   Numéro de banque avec poignée de glisser, à gauche.
2. Échange de banques par glisser du numéro, avec une copie de la ligne qui suit le pointeur et la ligne
   d'arrivée encadrée en pointillés (« Lâcher pour échanger les banques 07 et 03 »).
3. Panneau de droite centré sur la **banque choisie** : ses 5 presets, puis « Échanger avec la banque… »
   (bouton principal), Copier la banque, Coller ici, Envoyer la banque, Vider la banque ; en dessous, actions
   du preset choisi (Ouvrir dans l'éditeur, Échanger le preset…).
4. États visibles : banque en lecture (squelettes et indicateur), non lue (pointillés, toucher pour lire),
   protégée (cadenas, ni déplacée ni écrite), presets modifiés non envoyés (point ambre et compteur sur
   « Envoyer au G-System »), preset joué (point `--rig`).
5. Téléphone : liste des banques, 5 cases par ligne ; mode échange par appui long sur le numéro et bandeau en
   bas avec Annuler.

### Étape 4 : listes et réglages

Même hauteur de ligne, même sélection et mêmes boutons dans Réglages, Switches et MIDI ; captures du site
(`docs/`) refaites.

## Principes techniques à garder

- L'écran ne bloque jamais pendant un échange MIDI : tout changement s'affiche tout de suite puis part en
  file d'attente ; en Live, seuls les derniers mouvements d'un réglage sont envoyés ; la lecture des 40
  banques se fait en tâche de fond, banque par banque, avec le temps restant.
- Interface sans framework : DOM direct avec `el()` (`ui/dom.ts`), CSS dans `web/src/styles.css` (Modern) et
  `web/src/themes/oldschool.css` (règles préfixées par `:root[data-theme="oldschool"]`). Toute nouvelle
  interface doit être habillée dans les deux.
- Pas de fonctions CSS trop récentes sans vérifier la WebView cible (Android 7 minimum, SDK 24).

## Construire et tester

```sh
nvm use                      # Node 22 requis par Capacitor 8
npm ci
npx tsc --noEmit -p . && npm test && npm run build
npx cap sync android
cd android && ./gradlew assembleDebug   # ou installDebug avec la console branchée en débogage USB
# APK : android/app/build/outputs/apk/debug/app-debug.apk
```
