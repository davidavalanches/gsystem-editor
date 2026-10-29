# G-System Editor

Éditeur/bibliothécaire libre pour le multi-effet **TC Electronic G-System**, qui remplace
Vyzor G-System 2.00 (Psicraft, 2009, plus maintenu).

Une seule application web (TypeScript), qui tourne :

- **sur Android** : APK Capacitor, en paysage plein écran, MIDI USB natif (`android.media.midi`) ;
- **sur ordinateur** (Ubuntu, macOS, Windows) : dans Chrome ou Chromium, via Web MIDI.

Ce projet **ne contient aucun code de Vyzor**. Le format des données a été établi à partir
des dumps SysEx du G-System, des fichiers de banques de l'utilisateur, du manuel TC et des
tables de paramètres du firmware 4.02 (pour l'interopérabilité).

## Android

Le téléphone sert d'hôte USB : il faut un **câble OTG** (USB-C/micro-USB → USB-A) entre le
téléphone et le port USB du G-System.

```sh
npm install                 # Node 22 requis (nvm use 22)
npm run android             # build web + synchronisation Capacitor
cd android && ./gradlew assembleDebug
# APK : android/app/build/outputs/apk/debug/app-debug.apk
```

Variables nécessaires pour Gradle : `JAVA_HOME` (JDK 21 d'Android Studio, `…/android-studio/jbr`)
et le SDK Android dans `~/Android/Sdk` (`android/local.properties`).

## Ordinateur

```sh
npm install && npm run build
./scripts/install-desktop.sh     # ajoute « G-System Editor » au menu (Ubuntu)
./scripts/gsystem-editor.sh      # ou lancement direct
```

Pour le développement : `npm run dev`, puis ouvrir l'URL affichée dans Chrome.

## Fonctionnalités

- **Banques** : liste des 40 banques, les 5 presets de la banque avec le voyant de chacun des 8 effets,
  recherche par nom, appui long sur un preset pour renommer / copier / coller / vider, annulation (menu ⋮, Ctrl+Z).
- **Interface** : thème sombre en paysage, conçue pour un téléphone 5" (740×360 dp), polices IBM Plex et Doto
  embarquées (OFL).
- **Fichiers** : ouverture des banques Vyzor `.sqs` et des `.syx` ; export `.syx` (téléchargement
  sur ordinateur, `Documents/G-System/` sur Android). La banque en cours est conservée d'une
  session à l'autre.
- **Lecture du G-System** : toutes les banques (READ ALL BANKS, ~2 min 30, la liste se remplit au fur et à mesure)
  ou seulement la banque affichée (menu ⋮ ou vue MIDI, 0,8 s par preset).
- **Langue** : l'interface est en anglais.
- **Preset** : en-tête (preset précédent/suivant, numéro banque/position en points, nom, tempo avec les deux
  LEDs vertes de tempo, côte à côte, allumées à tour de rôle à chaque temps, voyant ambre « Modified » tant que le preset n'est pas
  stocké, Live, Store), 8 tuiles d'effets avec voyant et type, rangée Loop 1–4 / Insert / Boost, paramètres
  du bloc en potentiomètres (curseurs sur téléphone pour Reverb, Delay, Pitch), panneau de réglage fin sur
  téléphone (valeur, curseur, − / + maintenus, choix pour les listes), tampon d'édition avec Store.
  Sur ordinateur, pas de panneau latéral : les potentiomètres se tournent directement à la souris (glisser
  vers le haut ou le bas, Maj pour un réglage fin, double-clic pour le réglage fin) ou au clavier
  (flèches, Page préc./suiv., Début/Fin), les listes sont des menus déroulants.
- **Tempo des effets** : changer le Tap / TapTime ou la valeur de note (Tempo) d'un bloc recalcule son Delay
  ou sa Speed (tap × valeur de note, comme le fait le G-System) ; changer le tempo du preset fait de même
  pour Delay, Filter et Mod.
- **Routing et relais** (tuile ROUTING) : routing, niveaux de sortie, tempo, et les réglages de relais A et B
  (4 contacts chacun, ouvert / fermé, basculés par le switch Relay du pédalier).
- **Sélection de preset** : choisir un preset dans l'éditeur, G-System connecté, envoie Bank Select +
  Program Change sur le canal MIDI du G-System pour qu'il le rappelle (Prg.Chng.In doit être sur On).
  En Live, le preset est aussi écrit dans la mémoire de travail.
- **Store** : enregistre dans la banque de l'éditeur et, si le G-System est connecté, l'écrit dans le pédalier
  (séquence de Vyzor, adressée au SysEx ID du G-System, réglable dans la vue MIDI), puis le relit pour vérifier.
  Les banques **27 à 29** sont exclues de l'écriture : sur ce G-System, y écrire le bloque (zone mémoire défaillante).
- **Hors connexion** : sans G-System branché, chaque Store ou opération sur les banques est ajouté à une liste
  « à synchroniser » (gardée d'une session à l'autre, presets marqués en orange). Une fois le G-System connecté,
  « Sync (n) » ouvre la liste : écrire les presets cochés (chacun vérifié), les retirer de la liste,
  ou relire la version du G-System pour abandonner la modification (annulable).
- **Tester sur ordinateur** : `./scripts/gsystem-editor.sh` ouvre la même application dans Chrome/Chromium
  (vue téléphone : F12 puis mode appareil, 740×360).
- **Banques entières** (menu ⋮) : échanger la banque affichée avec une autre, ou la copier sur une autre ;
  appliqué dans l'éditeur (annulable) puis écrit preset par preset dans le G-System, chacun vérifié.
- **Pédales & encodeurs** (tuile PÉDALES) : pour chaque preset, quel paramètre suit la pédale d'expression,
  la pédale de volume ou les encodeurs A–C, avec Min / Mid / Max (en % de la plage du paramètre, valeur
  équivalente affichée). La liste suit les types d'effets choisis, comme sur le G-System ; les paramètres
  pilotés portent un badge EXP / VOL / ENC dans leur bloc. Enregistré avec le preset (Store), envoyé en Live.
- **Vue MIDI** : connexion, lectures, SysEx ID, et les réglages du menu MIDI du G-System (canal, Program Change
  In/Out, SysEx ID, MIDI Clock, CC des encodeurs et du tap), modifiables comme dans les réglages.
- **Live** : chaque modification part dans la mémoire de travail du G-System (rien n'est stocké),
  les switches du pédalier sont reflétés dans l'éditeur, et changer de preset au pied fait suivre
  l'éditeur (avec relecture du preset).

## Protocole (observé sur le matériel)

| Message | Rôle |
|---|---|
| `F0 7E 7F 06 01 F7` | Identification (réponse : firmware, ex. 4.05) |
| `F0 00 20 1F 00 55 45 01 <n° hi> <n° lo> F7` | Demande d'un preset stocké (réponse en 0,77 s ; une requête à la fois) |
| `F0 00 20 1F <dev> 55 20 01 <n°> <1032 quartets> <somme> F7` | Dump de preset (1044 octets) |
| `F0 00 20 1F 7F 55 22 <bloc> <param:2> <valeur:6 quartets> F7` | Écriture d'un paramètre de la mémoire de travail ; envoyé aussi par le G-System |
| `B0 00 <1\|2>` + `C0 <n>` | Changement de preset envoyé par le G-System ; l'éditeur envoie le même pour rappeler un preset (ignoré lors d'un premier essai en USB, à confirmer) |

Blocs : 1 = niveaux (loops 19–22, insert 23, boost 10, relais A 17 et B 18), 2 = EQ, 4 = Mod, 7 = Filter, 8 = Pitch,
9 = Delay, 10 = Comp, 11 = Reverb, 12 = Noise gate, 13 = modifiers (paramètres 20–57).

Données d'un preset : nom (21 octets) + 165 champs de 3 octets (entiers signés 24 bits) ; chaque
bloc d'effet est stocké `[nombre de paramètres][paramètres…]`. Voir `web/src/core/params.ts`.

Modifiers : champs 125–162, 38 emplacements regroupés par bloc (Filter 4, Comp 3, Mod 5, Pitch 8,
Delay 10, Reverb 4, NovaDrive 4). L'emplacement n d'un bloc pilote le n-ième paramètre modulable du type
d'effet courant. Chaque emplacement : source sur 3 bits (0 aucune, 1 Vol, 2 Exp, 3–5 encodeurs A–C) puis
Min, Mid et Max sur 7 bits chacun. Voir `web/src/core/modifiers.ts`.

## Tests

```sh
npm test
```

Les tests sur fichiers réels utilisent les banques de `GSYSTEM_SAMPLES` (par défaut
`~/Documents/Psicraft/Vyzor G-System`). Ces fichiers ne sont pas versionnés.
