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

### Application autonome (Electron)

`desktop/main.cjs` emballe l'app dans Electron, qui embarque Chromium (Web MIDI) : l'ordinateur
n'a besoin ni de Node, ni de Chrome, ni de serveur local.

```sh
npm run desktop       # lancement direct depuis le projet
npm run dist:mac      # release/G-System Editor-<version>-arm64-mac.zip (Apple Silicon) et -mac.zip (Intel)
npm run dist:linux    # AppImage
npm run dist:win      # Windows 64 bits : exécutable portable .exe et .zip (nécessite wine depuis Linux)
```

Sur Windows, l'app n'est pas signée : SmartScreen demande « Informations complémentaires » puis
« Exécuter quand même » au premier lancement. Un port MIDI n'y est utilisable que par un programme à la fois.

Le build macOS signe l'app en ad hoc (sans certificat Apple) avec
[rcodesign](https://github.com/indygreg/apple-platform-rs), qui doit être dans le `PATH` (ou son chemin
dans `RCODESIGN`). Sans cette signature, macOS dit l'app « endommagée » sur Apple Silicon.

Installation sur macOS : décompresser le zip, glisser « G-System Editor » dans Applications. L'app
n'est pas notarisée par Apple ; au premier lancement, dans le Terminal :

```sh
xattr -cr "/Applications/G-System Editor.app"
codesign --force --deep -s - "/Applications/G-System Editor.app"   # si macOS la dit encore « endommagée »
```

#### Le G-System n'apparaît pas sur Mac

Le G-System est un périphérique MIDI USB standard (USB `1220:0005`, sans pilote) : l'app ne voit que
ce que macOS affiche dans Configuration audio et MIDI → Fenêtre → Afficher le studio MIDI. Vérifier
d'abord menu Pomme → À propos de ce Mac → Plus d'infos → Rapport système → USB, G-System allumé et branché.

- **Absent de la liste USB** : câble ou adaptateur. Allumer le G-System avant de le brancher, essayer
  un câble USB-C vers USB-B direct (sans dock ni hub), un autre câble, un autre port. Certains docks
  USB-C gèrent mal les anciens appareils USB 1.1.
- **Présent en USB mais grisé (ou absent) dans le studio MIDI** :
  1. Retirer tout ancien pilote TC Electronic de `/Library/Audio/MIDI Drivers` et
     `~/Library/Audio/MIDI Drivers` (fichiers `.plugin`), puis redémarrer : un ancien pilote peut
     s'emparer du G-System sans fonctionner sur Apple Silicon.
  2. Débrancher, supprimer l'icône grisée du studio MIDI, rebrancher (allumé, directement sur le Mac),
     « Rechercher MIDI ». S'il reste grisé : nouvelle configuration dans le studio MIDI.
  3. Essayer un autre port, ou un hub USB 2.0 simple entre le Mac et le G-System.
- **Contournement** : une interface USB-MIDI sans pilote (Roland UM-ONE…) sur les prises MIDI In et
  MIDI Out à 5 broches du G-System, les deux reliées (lecture des banques plus lente).

## Fonctionnalités

- **Banques** : liste des 40 banques, les 5 presets de la banque avec le voyant de chacun des 8 effets,
  recherche par nom, appui long sur un preset pour renommer / copier / coller / vider, annulation (menu ⋮, Ctrl+Z).
  Sur ordinateur, glisser l'en-tête d'une banque sur une autre (ou un preset sur un autre) propose de les échanger
  ou de copier. Sur téléphone, un appui long sur une banque de la liste la soulève : la glisser sur une autre propose
  l'échange (la liste défile au bord), la relâcher sans bouger ouvre le menu de la banque. Menu d'une banque : lire, échanger, copier, exporter, vider (« Clear bank »), protéger en écriture.
  Toute modification de la banque (renommer, coller, vider, échanger, copier) s'ajoute à la liste « Store (n) » pour
  être écrite dans le G-System ; vider un emplacement (ou une banque) y met un preset « Empty »
  (tous les effets, loops, insert, boost et modifiers coupés), car le G-System n'accepte que des presets complets.
- **Noms des loops** : appui long (clic droit sur ordinateur) sur Loop 1 à 4 pour y noter la pédale branchée.
  Les noms sont propres à chaque G-System (SysEx ID), gardés sur l'appareil, et repris dans le détail de la vue Banks.
- **Interface** : thème sombre en paysage, conçue pour un téléphone 5" (740×360 dp), polices IBM Plex et Doto
  embarquées (OFL).
- **Import** (menu ⋮ → « Import banks from a file… ») : prendre des banques d'une sauvegarde `.sqs` / `.syx`, venant de
  n'importe quel G-System (le SysEx ID n'intervient pas), dans les mêmes banques ou dans la banque affichée, sans
  remplacer le reste ; les presets importés attendent dans la liste « Store (n) ». « Send to the G-System » (menu d'un
  preset) et « Send bank to the G-System » (menu d'une banque) écrivent dans le G-System les presets de l'éditeur
  même non modifiés, pour écraser ceux de l'appareil.
- **Fichiers** : ouverture des banques Vyzor `.sqs` et des `.syx` ; export `.syx` (téléchargement
  sur ordinateur ; sur Android, l'écran « Enregistrer sous » du système : dossier au choix, Drive…, sans permission de stockage). La banque en cours est conservée d'une
  session à l'autre.
- **Lecture du G-System** : « Connect » propose, une fois le G-System identifié, de lire toutes les banques ou la banque affichée. Toutes les banques (READ ALL BANKS, ~2 min 30, la liste se remplit au fur et à mesure,
  en commençant par la banque affichée ; tant qu'un preset n'est pas lu, il est grisé et ne peut être ni ouvert
  ni modifié)
  ou seulement la banque affichée (menu ⋮ ou vue MIDI, 0,8 s par preset).
- **Langue** : l'interface est en anglais.
- **Preset** : en-tête (preset précédent/suivant, numéro banque/position en points, nom, tempo avec les deux
  LEDs vertes de tempo, côte à côte, allumées à tour de rôle à chaque temps, voyant ambre « Modified » tant que le preset n'est pas
  stocké, Live, Store), 8 tuiles d'effets avec leur switch dessiné comme sur le G-System (dôme chrome sur base
  translucide qui s'allume en rouge) et leur type, rangée Loop 1–4 / Insert / Relay / Boost (fond plein quand actif,
  noms complets sur ordinateur), paramètres
  du bloc en potentiomètres (curseurs sur téléphone pour Reverb, Delay, Pitch), panneau de réglage fin sur
  téléphone (valeur, curseur, − / + maintenus, choix pour les listes), tampon d'édition avec Store.
  Sur ordinateur, pas de panneau latéral : les potentiomètres se tournent directement à la souris (glisser
  vers le haut ou le bas, Maj pour un réglage fin, double-clic pour le réglage fin) ou au clavier
  (flèches, Page préc./suiv., Début/Fin), les listes sont des menus déroulants.
- **Paramètres des effets** : chaque type d'effet ne montre que les paramètres du manuel du G-System, comme sur
  l'appareil (ex. Resonance Filter : Style, Hicut, Resnce, OutLev). Les Univibe n'affichent que la Speed et le
  Tempo de la vitesse choisie par Select.
- **Tempo des effets** : changer la valeur de note (Tempo) d'un bloc recalcule son Delay ou sa Speed (tempo du
  preset × valeur de note, comme le fait le G-System) ; changer le tempo du preset (300 BPM au plus) fait de même
  pour Delay, Filter et Mod.
- **Boost** : niveau par preset, limité au réglage global Boost Max (Gbl Levels) une fois celui-ci lu.
- **Routing et relais** (tuile ROUTING) : routing, niveaux de sortie, tempo, et les réglages de relais A et B
  (4 contacts chacun, ouvert / fermé, basculés par le switch Relay du pédalier).
- **Sélection de preset** : choisir un preset dans l'éditeur, G-System connecté, envoie Bank Select +
  Program Change sur le canal MIDI du G-System pour qu'il le rappelle. Il faut Prg. Change In sur On (vue MIDI) :
  sinon le G-System ignore le rappel, et l'éditeur propose de l'activer.
  En Live, le preset est aussi écrit dans la mémoire de travail.
- **Store** : enregistre dans la banque de l'éditeur et, si le G-System est connecté, l'écrit dans le pédalier
  (séquence de Vyzor, adressée au SysEx ID du G-System, réglable dans la vue MIDI), puis le relit pour vérifier.
  Une banque peut être **protégée en écriture** (menu de la banque, « Protect from writing ») : rien n'y est alors
  écrit dans le G-System, utile quand une zone mémoire défaillante le bloque. Une banque dont le G-System signale
  un emplacement endommagé est protégée d'office, jusqu'à une relecture qui le trouve sain.
- **Hors connexion** : sans G-System branché, chaque Store ou opération sur les banques est ajouté à une liste
  « à synchroniser » (gardée d'une session à l'autre, presets marqués en orange). Une fois le G-System connecté,
  « Store (n) » ouvre la liste : écrire les presets cochés (chacun vérifié), les retirer de la liste,
  ou relire la version du G-System pour abandonner la modification (annulable).
- **Tester sur ordinateur** : `./scripts/gsystem-editor.sh` ouvre la même application dans Chrome/Chromium
  (vue téléphone : F12 puis mode appareil, 740×360).
- **Banques entières** (menu ⋮) : échanger la banque affichée avec une autre, ou la copier sur une autre ;
  appliqué dans l'éditeur (annulable) puis écrit preset par preset dans le G-System, chacun vérifié.
- **Pédales & encodeurs** (tuile PÉDALES) : pour chaque preset, quel paramètre suit la pédale d'expression,
  la pédale de volume ou les encodeurs A–C, avec Min / Mid / Max (en % de la plage du paramètre, valeur
  équivalente affichée). La liste suit les types d'effets choisis, comme sur le G-System ; les paramètres
  pilotés portent un badge EXP / VOL / ENC dans leur bloc. Enregistré avec le preset (Store), envoyé en Live.
- **Plusieurs G-System** : chacun a son espace de travail (banque, liste Store, banques protégées, réglages lus),
  reconnu à la connexion par son **SysEx ID**, qui doit donc être différent sur chaque G-System (menu MIDI du
  G-System). Un nom est demandé à la première connexion ; menu ⋮ → « G-System: … » pour changer d'espace hors
  connexion ou le renommer. Menu d'un preset ou d'une banque : « Copy to the other G-System… » le copie dans
  l'espace de l'autre, où il attend dans sa liste Store. Les presets en attente d'un G-System ne partent jamais vers un autre.
- **Vue MIDI** : connexion, lectures, SysEx ID, et les réglages du menu MIDI du G-System (canal, Program Change
  In/Out, SysEx ID, MIDI Clock, CC des encodeurs et du tap), modifiables comme dans les réglages.
- **Réglages globaux du G-System** : vue **Settings** (niveaux, utilitaires, pédales, accordeur), vue **MIDI**
  (réglages MIDI) et vue **Switches** (le pédalier dessiné comme sur le G-System, 3 rangées de 6 switches avec
  leur fonction ; toucher un switch pour la changer). Lus à l'ouverture de la vue, modifiables hors connexion,
  écrits par « Send » puis relus pour vérifier. Les favoris d'effets (4 par bloc) sont propres à chaque G-System.
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
| `B0 00 <1\|2>` + `C0 <n>` | Changement de preset envoyé par le G-System ; l'éditeur envoie le même pour rappeler un preset (ignoré si Prg. Change In est sur Off) |

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

## Licence

G-System Editor est un logiciel libre distribué sous licence **GNU GPL v3** (voir [`LICENSE`](LICENSE)).
Vous pouvez l'utiliser, l'étudier, le modifier et le redistribuer. Toute version redistribuée, modifiée ou
non, doit rester sous GPL v3 et être accompagnée de son code source.

Composants tiers : Capacitor, Vite et Electron (MIT) ; polices IBM Plex, Michroma, Doto et VT323 (SIL Open
Font License).

G-System, Nova System et TC Electronic sont des marques de leurs propriétaires. Ce projet n'est ni affilié à
TC Electronic ni approuvé par la marque. Les tables du firmware servent uniquement à l'interopérabilité.
