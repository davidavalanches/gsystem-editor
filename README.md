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
- **Lecture du G-System** : toute la banque (~2 min 30, la liste se remplit au fur et à mesure)
  ou seulement la banque affichée (menu ⋮ ou vue MIDI, 0,8 s par preset).
- **Preset** : en-tête (preset précédent/suivant, numéro banque/position en points, nom, Live, Store),
  8 tuiles d'effets avec voyant et type, rangée Loop 1–4 / Insert / Boost (en Live), paramètres du bloc
  en curseurs sur deux colonnes, panneau de réglage fin (valeur, curseur, − / + maintenus, choix pour
  les listes), tampon d'édition avec Store.
- **Store** : enregistre dans la banque de l'éditeur et, si le G-System est connecté, l'écrit dans le pédalier
  (séquence de Vyzor, adressée au SysEx ID du G-System, réglable dans la vue MIDI), puis le relit pour vérifier.
  Les banques **27 à 29** sont exclues de l'écriture : sur ce G-System, y écrire le bloque (zone mémoire défaillante).
- **Banques entières** (menu ⋮) : échanger la banque affichée avec une autre, ou la copier sur une autre ;
  appliqué dans l'éditeur (annulable) puis écrit preset par preset dans le G-System, chacun vérifié.
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
| `B0 00 <1\|2>` + `C0 <n>` | Changement de preset envoyé par le G-System (ignoré en entrée sur USB) |

Blocs : 1 = niveaux (loops 19–22, insert 23, boost 10), 2 = EQ, 4 = Mod, 7 = Filter, 8 = Pitch,
9 = Delay, 10 = Comp, 11 = Reverb, 12 = Noise gate.

Données d'un preset : nom (21 octets) + 165 champs de 3 octets (entiers signés 24 bits) ; chaque
bloc d'effet est stocké `[nombre de paramètres][paramètres…]`. Voir `web/src/core/params.ts`.

## Tests

```sh
npm test
```

Les tests sur fichiers réels utilisent les banques de `GSYSTEM_SAMPLES` (par défaut
`~/Documents/Psicraft/Vyzor G-System`). Ces fichiers ne sont pas versionnés.
