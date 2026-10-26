"""Command-line tool: inspect and export G-System banks."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .sqs import SqsFile, read_syx, write_syx
from .sysex import Preset


def load_presets(path: Path) -> list[Preset | None]:
    if path.suffix.lower() == ".syx":
        return list(read_syx(path))
    return SqsFile.load(path).user_presets()


def cmd_info(args: argparse.Namespace) -> int:
    presets = load_presets(args.file)
    problems = 0
    for slot, p in enumerate(presets):
        if p is None:
            if args.all:
                print(f"{slot:3d}  ---  (vide)")
            continue
        flags = []
        if not p.checksum_ok:
            flags.append("SOMME DE CONTROLE INVALIDE")
        if p.user_slot is not None and p.user_slot != slot and args.file.suffix.lower() != ".syx":
            flags.append(f"numero stocke {p.number}")
        problems += not p.checksum_ok
        print(f"{slot:3d}  {p.number:3d}  {p.name:<20}  {'  '.join(flags)}")
    used = sum(p is not None for p in presets)
    print(f"\n{used} presets, {problems} avec une somme de controle invalide")
    return 1 if problems else 0


def cmd_export(args: argparse.Namespace) -> int:
    presets = [p for p in load_presets(args.file) if p is not None]
    if args.valid_only:
        presets = [p for p in presets if p.checksum_ok]
    write_syx(args.output, presets)
    print(f"{len(presets)} presets exportes vers {args.output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gsystem-tool", description="Outils pour les banques G-System")
    sub = parser.add_subparsers(required=True)

    info = sub.add_parser("info", help="lister les presets d'un fichier .sqs ou .syx")
    info.add_argument("file", type=Path)
    info.add_argument("-a", "--all", action="store_true", help="afficher aussi les emplacements vides")
    info.set_defaults(func=cmd_info)

    export = sub.add_parser("export", help="exporter les presets en .syx")
    export.add_argument("file", type=Path)
    export.add_argument("output", type=Path)
    export.add_argument("--valid-only", action="store_true", help="ignorer les presets a somme invalide")
    export.set_defaults(func=cmd_export)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
