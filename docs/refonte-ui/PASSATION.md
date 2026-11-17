# Refonte UI de G-System Editor : passation

Document de reprise pour une nouvelle session (autre compte, autre outil). Il résume les décisions prises,
l'état du code et les étapes restantes. Les maquettes d'origine sont un canevas de design privé
à l'autre compte ; tout ce qu'il faut pour coder est décrit ici.

## État actuel

- Branche : `refonte-ui-etape-1` (partie de `main` en version 1.0.5). Pas encore fusionnée.
- Étape 1 faite (styles et états, aucun changement de comportement) :
  - une seule palette sombre ; finitions Black/Grey/Red brushed, `ui/skin.ts` et le menu « Appearance » supprimés ;
  - police Inter (`@fontsource/inter` 400 à 700) partout ; Michroma, IBM Plex, VT323, Doto et Barlow retirés ;
  - libellés en casse normale (« Filter », « Reverb », « Modifiers ») ;
  - switch d'un bloc = carré avec l'icône du bloc (`BLOCK_ICONS` / `blockIcon()` dans `ui/widgets.ts`) :
    vide et gris éteint, plein de la couleur du bloc allumé ; la tuile allumée prend une teinte et un contour
    de cette couleur (variables `--h` et `--t` posées en TS sur chaque tuile) ;
  - loops, insert, boost, contacts de relais et Live allumés en corail `#ff6b5b` (`--rig`) ;
  - sélection = contour neutre `--ink` ; ambre `--amber` réservé à « pas encore enregistré » ;
  - plus de textures, halos ni écran LCD : numéro et nom du preset en texte.
  - `.nvmrc` (22) et `engines.node >= 22` ajoutés.
- À vérifier par l'utilisateur sur sa console (Retroid Pocket Flip 2, Android 13) : la teinte des blocs allumés.
  Elle n'apparaissait pas, très probablement parce que l'APK n'avait pas été reconstruit (Node < 22 bloquait
  `cap sync`). Les teintes sont en `rgba` fixes, sans `color-mix`.
- Non fait dans la session précédente : `npm test`, `npm run build` (installation de paquets impossible
  là-bas). `package-lock.json` doit être régénéré par `npm install` et commité.

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

**Cibles :** écran d'ordinateur (maquettes en 1920×1080) et téléphone Android 5 pouces en paysage (740×360 dp).
Zones de toucher d'au moins 44 px.

## Prochaines étapes

Chaque étape = une version à essayer sur le téléphone avant la suivante.

### Étape 2 : vue Preset

1. Remplacer la grille 2×4 de tuiles par la **chaîne du signal** dans l'ordre ci-dessus.
   - Ordinateur : une ligne. Entrée, Filter, Comp, bloc Loops (L1 à L4 et Insert empilés, avec leurs noms
     de `LoopNames`), Gate, EQ, groupe routé encadré en pointillés (titre = nom du routing), Sortie.
     Tuiles horizontales d'environ 128×62 px : carré d'icône de 52 px à gauche (toggle), nom et type à droite.
   - Téléphone : une rangée de tuiles d'environ 70×88 px (icône en haut, nom et type en bas) : Filter, Comp,
     un repère étroit « Loop » avec 5 petits carrés allumés en `--rig`, Gate, EQ, puis le groupe routé
     encadré avec l'icône du routing. Les loops, l'insert, le relais et le boost restent en rangée de puces
     de 44 px sous les tuiles.
2. Le **groupe routé se redessine selon le routing** (voir Décisions). Le sélecteur de routing devient un
   sélecteur segmenté avec les icônes existantes (`routingIcon`, ajouter un dessin pour Série 2).
3. **Éditeur du bloc choisi** sous la chaîne : icône, nom, menu du type, bouton Allumé/Éteint, 4 favoris ;
   potards dont l'arc prend la couleur du bloc (`--h`) ; badge EXP / ENC A / VOL sur un réglage piloté par un
   modificateur, avec sa course visible sur le curseur fin.
4. En-tête : numéro et nom du preset, point ambre « Modifié », tempo avec LED et Tap, Live (en `--rig` quand
   actif), Annuler/Rétablir, Comparer, « Enregistrer dans 07-3 » en bouton principal.
5. Ordinateur, colonne de droite : les 5 presets de la banque (avec une rangée de 8 pastilles des blocs
   allumés, dans l'ordre de la chaîne), relais A/B et boost, modificateurs du preset, sorties et NovaDrive.

### Étape 3 : vue Banques

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
- Interface sans framework : DOM direct avec `el()` (`ui/dom.ts`), CSS dans `web/src/styles.css`.
- Pas de fonctions CSS trop récentes sans vérifier la WebView cible (Android 7 minimum, SDK 24).

## Construire et tester

```sh
nvm use                      # Node 22 requis par Capacitor 8
npm install
npm test && npm run build
npx cap sync android
cd android && ./gradlew assembleDebug   # ou installDebug avec la console branchée en débogage USB
# APK : android/app/build/outputs/apk/debug/app-debug.apk
```
