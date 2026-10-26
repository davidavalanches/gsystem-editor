# G-System Editor

Éditeur/bibliothécaire libre pour le multi-effet **TC Electronic G-System**, qui remplace
Vyzor G-System 2.00 (Psicraft, 2009, plus maintenu). Fonctionne sous Ubuntu et macOS
(Python + Qt 6, MIDI via ALSA / CoreMIDI).

Ce projet **ne contient aucun code de Vyzor**. Le format des données a été établi
uniquement à partir des dumps SysEx que produit le G-System et des fichiers de
banques de l'utilisateur.

## Installation

```sh
sudo apt install python3-venv          # Ubuntu, une seule fois
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
./install-desktop.sh                   # ajoute « G-System Editor » au menu
```

Lancement : `.venv/bin/gsystem-editor [banque.sqs]`

## Fonctionnalités (v0.1)

- Ouvre les banques Vyzor `.sqs` et les fichiers SysEx `.syx` (200 emplacements utilisateur).
- Signale les presets dont la **somme de contrôle** est invalide, et la recalcule toujours à l'enregistrement.
- Renommer, copier/coller, vider des emplacements, avec **annulation illimitée** (Ctrl+Z).
- Demande confirmation avant de remplacer un preset existant.
- Enregistrement **atomique**, avec une **copie de sauvegarde `.bak` horodatée** du fichier remplacé.
- Garde toutes les autres données du fichier `.sqs`, qui reste lisible par Vyzor.
- Export `.syx` de toute la banque ou de la sélection, et import `.syx`.
- Taille d'affichage réglable (Ctrl + / Ctrl − / Ctrl 0), conservée entre les sessions.
- MIDI en **réception seule** : capture des presets envoyés par le G-System, enregistrement des captures brutes.

En ligne de commande :

```sh
.venv/bin/gsystem-tool info banque.sqs          # liste + vérification des sommes de contrôle
.venv/bin/gsystem-tool export banque.sqs out.syx
```

## Format d'un preset (observé)

```
F0 00 20 1F <dev> 55 20 01 <n° hi> <n° lo> <1032 quartets> <somme> F7     (1044 octets)
```

| Élément | Détail |
|---|---|
| `00 20 1F` | Identifiant fabricant TC Electronic |
| `55` | Modèle G-System |
| `20 01` | Dump de preset |
| Numéro | 14 bits ; les presets utilisateur commencent à 100 (emplacement 1 = 100) |
| Données | 516 octets, chacun envoyé en deux quartets (poids fort d'abord) |
| Somme | Somme de tous les quartets, sur 7 bits |
| Nom | 20 premiers octets ; le bit 7 sert d'indicateur interne (masqué à l'affichage, conservé) |

Fichier `.sqs` : conteneur IFF (`LIST` → `FORM BANK` → `SHDR`, `BODY`…). La banque
« User Bank » contient 200 emplacements de 1310 octets. Les tailles de `FORM` écrites
par Vyzor sont fausses : il ne faut pas s'y fier.

## Feuille de route

1. **Avec le G-System branché** : capturer les échanges (demande de dump, envoi, réception)
   pour valider le protocole, puis activer l'envoi avec **relecture et vérification**
   après chaque écriture.
2. Correspondance octet ↔ paramètre (ampli, drive, délai, réverb, modulation…), établie en
   comparant des dumps avant et après chaque changement fait sur le pédalier.
3. Éditeur de paramètres en temps réel, avec une interface adaptée aux écrans actuels.
4. Paquets : AppImage (Linux) et `.app` (macOS) via PyInstaller.

## Tests

```sh
.venv/bin/python -m pytest
```

Les tests sur fichiers réels utilisent les banques de `GSYSTEM_SAMPLES` (par défaut
`~/Documents/Psicraft/Vyzor G-System`). Ces fichiers ne sont pas versionnés.
