"""G-System Editor main window."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QFont, QFontDatabase, QKeySequence, QUndoGroup
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QButtonGroup,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDockWidget,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSplitter,
    QStackedWidget,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from . import __version__
from .editor import PresetEditor
from .params import SWITCH_BLOCKS, block
from .midi import GSystemReader, MidiInput, is_gsystem_identity
from .model import COL_NAME, BankModel, Library, slot_label
from .sqs import atomic_write, read_syx
from .sysex import USER_SLOTS, Preset, SysexError, checksum, bytes_to_nibbles, is_preset_dump

FILE_FILTER = "Banques G-System (*.sqs *.SQS *.syx *.SYX);;Tous les fichiers (*)"
ZOOM_STEPS = (0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5)


def hex_dump(data: bytes, width: int = 16) -> str:
    lines = []
    for off in range(0, len(data), width):
        chunk = data[off : off + width]
        text = "".join(chr(b & 0x7F) if 0x20 <= (b & 0x7F) < 0x7F else "." for b in chunk)
        lines.append(f"{off:04X}  {chunk.hex(' ').upper():<{width * 3}} {text}")
    return "\n".join(lines)


class DetailPanel(QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.title = QLabel()
        self.info = QLabel()
        self.info.setWordWrap(True)
        self.hex = QPlainTextEdit(readOnly=True)
        self.hex.setLineWrapMode(QPlainTextEdit.NoWrap)
        self.rescale(self.title.font())

        layout = QVBoxLayout(self)
        layout.addWidget(self.title)
        layout.addWidget(self.info)
        layout.addWidget(QLabel("Données brutes (516 octets, décodés) :"))
        layout.addWidget(self.hex, 1)
        self.show_preset(None, None)

    def rescale(self, base: QFont) -> None:
        title_font = QFont(base)
        title_font.setPointSizeF(base.pointSizeF() * 1.6)
        title_font.setBold(True)
        self.title.setFont(title_font)
        mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        mono.setPointSizeF(base.pointSizeF())
        self.hex.setFont(mono)

    def show_preset(self, slot: int | None, preset: Preset | None) -> None:
        if slot is None:
            self.title.setText("Aucune sélection")
            self.info.setText("")
            self.hex.clear()
            return
        if preset is None:
            self.title.setText(f"{slot_label(slot)} — vide")
            self.info.setText("")
            self.hex.clear()
            return
        self.title.setText(f"{slot_label(slot)} — {preset.name}")
        computed = checksum(bytes_to_nibbles(preset.data))
        lines = [f"Numéro MIDI interne : {preset.number}"]
        if preset.user_slot != slot:
            lines.append(f"⚠ Numéro d'origine différent de l'emplacement (sera renuméroté en {100 + slot}).")
        if preset.source_checksum is None:
            lines.append(f"Somme de contrôle : {computed} (recalculée)")
        elif preset.checksum_ok:
            lines.append(f"Somme de contrôle : {computed} ✔")
        else:
            lines.append(f"⚠ Somme de contrôle stockée {preset.source_checksum}, calculée {computed}")
        self.info.setText("\n".join(lines))
        self.hex.setPlainText(hex_dump(preset.data))


# Block ids observed on the hardware; the others are learned with LearnBlocksDialog.
KNOWN_BLOCK_IDS = {"mod": 4, "delay": 9}


class LearnBlocksDialog(QDialog):
    """Asks the user to press each effect switch and records the block id it sends."""

    def __init__(self, reader, block_ids: dict[str, int], parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Apprendre les switches du G-System")
        self.block_ids = dict(block_ids)
        self.todo = [k for k in SWITCH_BLOCKS if k not in self.block_ids]
        self.prompt = QLabel()
        self.prompt.setWordWrap(True)
        font = self.prompt.font()
        font.setPointSizeF(font.pointSizeF() * 1.4)
        self.prompt.setFont(font)
        self.log = QLabel()
        self.log.setWordWrap(True)
        skip = QPushButton("Passer ce switch")
        skip.clicked.connect(self.skip)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Appuyez sur chaque switch demandé, une seule fois. Rien n'est enregistré "
                                "sur le G-System : vous pourrez rétablir l'état du switch ensuite."))
        layout.addWidget(self.prompt)
        layout.addWidget(skip)
        layout.addWidget(self.log)
        layout.addWidget(buttons)
        reader.param_changed.connect(self.on_param)
        self.show_next()

    def show_next(self) -> None:
        known = ", ".join(f"{block(k).label} = {v}" for k, v in sorted(self.block_ids.items(), key=lambda kv: kv[1]))
        self.log.setText(f"Connus : {known}")
        if self.todo:
            self.prompt.setText(f"Appuyez sur le switch <b>{block(self.todo[0]).label.upper()}</b>")
        else:
            self.prompt.setText("Terminé. Cliquez sur OK pour enregistrer.")

    def skip(self) -> None:
        if self.todo:
            self.todo.pop(0)
            self.show_next()

    def on_param(self, block_id: int, _param: int, _value: int) -> None:
        if not self.todo or block_id in self.block_ids.values():
            return
        self.block_ids[self.todo.pop(0)] = block_id
        self.show_next()


class MidiPanel(QWidget):
    """Connection to the G-System: identification, bank reading and raw capture."""

    def __init__(self, window: MainWindow) -> None:
        super().__init__(window)
        self.window = window
        self.midi = MidiInput(self)
        self.midi.message.connect(self.on_message)
        self.reader = GSystemReader(self.midi, self)
        self.reader.progress.connect(self.on_progress)
        self.reader.finished.connect(self.on_bank_read)
        self.reader.param_changed.connect(self.on_param_changed)
        self.capture: list[bytes] = []

        self.ports = QComboBox()
        refresh = QPushButton("Actualiser")
        refresh.clicked.connect(self.refresh_ports)
        self.connect_button = QPushButton("Connecter", checkable=True)
        self.connect_button.toggled.connect(self.on_connect)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.read_button = QPushButton("Lire la banque du G-System")
        self.read_button.setToolTip("Demande les 200 presets utilisateur un par un (lecture seule)")
        self.read_button.clicked.connect(self.read_bank)
        self.read_button.setEnabled(False)
        self.progress = QProgressBar()
        self.progress.hide()
        self.learn_button = QPushButton("Apprendre les switches…")
        self.learn_button.setToolTip("Identifier le numéro de bloc de chaque switch d'effet")
        self.learn_button.clicked.connect(self.learn_blocks)
        self.learn_button.setEnabled(False)
        self.received = QListWidget()
        self.received.setSelectionMode(QAbstractItemView.ExtendedSelection)
        add = QPushButton("Placer dans la banque…")
        add.clicked.connect(self.add_to_bank)
        save_capture = QPushButton("Enregistrer la capture brute…")
        save_capture.clicked.connect(self.save_capture)

        row = QHBoxLayout()
        row.addWidget(self.ports, 1)
        row.addWidget(refresh)
        layout = QVBoxLayout(self)
        layout.addLayout(row)
        layout.addWidget(self.connect_button)
        layout.addWidget(self.status)
        layout.addWidget(self.read_button)
        layout.addWidget(self.progress)
        layout.addWidget(self.learn_button)
        layout.addWidget(QLabel("Messages et presets reçus :"))
        layout.addWidget(self.received, 1)
        layout.addWidget(add)
        layout.addWidget(save_capture)
        hint = QLabel("« En direct » (mode Preset) modifie uniquement la mémoire de travail du G-System : "
                      "rien n'est stocké dans le pédalier. Changer de preset sur le G-System annule tout.")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        self.refresh_ports()

    def refresh_ports(self) -> None:
        self.ports.clear()
        if not MidiInput.available():
            self.status.setText("python-rtmidi n'est pas installé.")
            return
        ports = MidiInput.ports()
        self.ports.addItems(ports)
        for i, name in enumerate(ports):
            if "G-System" in name:
                self.ports.setCurrentIndex(i)
        self.status.setText(f"{len(ports)} port(s) MIDI détecté(s)." if ports else "Aucun port MIDI détecté.")

    def on_connect(self, on: bool) -> None:
        if not on:
            if self.reader.busy:
                self.reader.cancel()
            self.midi.close()
            self.reader.close_output()
            self.read_button.setEnabled(False)
            self.learn_button.setEnabled(False)
            self.window.set_live_available(False)
            self.status.setText("Déconnecté.")
            return
        if self.ports.currentIndex() < 0:
            self.connect_button.setChecked(False)
            return
        try:
            self.midi.open(self.ports.currentIndex())
            self.reader.open_output(self.ports.currentText())
            self.reader.identify()
        except Exception as exc:  # rtmidi raises its own error types
            self.connect_button.setChecked(False)
            self.midi.close()
            QMessageBox.warning(self, "MIDI", f"Impossible d'ouvrir le port : {exc}")
            return
        self.status.setText(f"Connecté à « {self.midi.port_name} », identification…")

    def on_message(self, msg: bytes) -> None:
        self.capture.append(msg)
        if is_gsystem_identity(msg):
            version = f"{msg[14]}.{msg[15]:02d}"
            self.status.setText(f"G-System détecté (version {version}).")
            self.read_button.setEnabled(True)
            self.learn_button.setEnabled(True)
            self.window.set_live_available(True)
            return
        if self.reader.busy or msg[5:7] == b"\x55\x22":
            return
        if not is_preset_dump(msg):
            self.received.addItem(msg[:16].hex(" ") + ("…" if len(msg) > 16 else ""))
            return
        preset = Preset.from_sysex(msg, strict=False)
        state = "" if preset.checksum_ok else "  ⚠ somme invalide"
        item = QListWidgetItem(f"{preset.number:3d}  {preset.name}{state}")
        item.setData(Qt.UserRole, preset)
        self.received.addItem(item)

    def on_param_changed(self, block_id: int, param: int, value: int) -> None:
        self.window.editor.apply_from_unit(block_id, param, value)

    def learn_blocks(self) -> None:
        dialog = LearnBlocksDialog(self.reader, self.window.editor.block_ids, self)
        if dialog.exec() == QDialog.Accepted:
            self.window.set_block_ids(dialog.block_ids)

    def read_bank(self) -> None:
        if self.reader.busy:
            self.reader.cancel()
            return
        if not self.window.maybe_discard():
            return
        self.read_button.setText("Annuler la lecture")
        self.progress.setRange(0, USER_SLOTS)
        self.progress.setValue(0)
        self.progress.show()
        self.reader.read_bank()

    def on_progress(self, done: int, total: int) -> None:
        self.progress.setValue(done)
        self.status.setText(f"Lecture du preset {done}/{total}…")

    def on_bank_read(self, presets: list, missing: list) -> None:
        self.read_button.setText("Lire la banque du G-System")
        self.progress.hide()
        if not presets:
            self.status.setText("Aucun preset reçu.")
            return
        self.window.load_from_device(presets)
        self.status.setText(f"{len(presets)} presets lus, {len(missing)} emplacement(s) vide(s).")

    def add_to_bank(self) -> None:
        presets = [item.data(Qt.UserRole) for item in self.received.selectedItems() if item.data(Qt.UserRole)]
        changes = {p.user_slot: p for p in presets if p.user_slot is not None}
        if changes and self.window.confirm_overwrite(changes):
            self.window.model.set_slots(changes, f"Réception MIDI de {len(changes)} preset(s)")

    def save_capture(self) -> None:
        if not self.capture:
            return
        default = f"capture-{datetime.now():%Y%m%d-%H%M%S}.syx"
        path, _ = QFileDialog.getSaveFileName(self, "Enregistrer la capture", default, "SysEx (*.syx)")
        if path:
            atomic_write(Path(path), b"".join(self.capture))

    def shutdown(self) -> None:
        if self.reader.busy:
            self.reader.cancel()
        self.midi.close()
        self.reader.close_output()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.settings = QSettings("gsystem-editor", "gsystem-editor")
        self.clipboard: list[Preset | None] = []
        self.model = BankModel(Library(), self)
        self.model.undo_stack.cleanChanged.connect(self.update_title)

        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.DoubleClicked | QAbstractItemView.EditKeyPressed)
        self.table.verticalHeader().hide()
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_NAME, QHeaderView.Stretch)
        self.table.selectionModel().currentRowChanged.connect(self.on_current_changed)
        self.model.dataChanged.connect(lambda *_: self.on_current_changed(self.table.currentIndex()))

        self.detail = DetailPanel()
        splitter = QSplitter()
        splitter.addWidget(self.table)
        splitter.addWidget(self.detail)
        splitter.setChildrenCollapsible(False)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        self.splitter = splitter

        self.editor = PresetEditor(self.model)
        try:
            learned = json.loads(self.settings.value("block_ids", "{}"))
        except (TypeError, ValueError):
            learned = {}
        self.editor.block_ids = {**KNOWN_BLOCK_IDS, **learned}
        self.editor.store_requested.connect(
            lambda slot, preset: self.model.set_slots({slot: preset}, f"Store « {preset.name} »"))
        self.model.dataChanged.connect(lambda top, _bottom: self.editor.reload_if_showing(top.row()))
        self.model.modelReset.connect(lambda: self.editor.open_slot(0))
        self.table.doubleClicked.connect(lambda index: self.show_preset(index.row()))

        self.undo_group = QUndoGroup(self)
        self.undo_group.addStack(self.model.undo_stack)
        self.undo_group.addStack(self.editor.undo_stack)

        self.pages = QStackedWidget()
        self.pages.addWidget(splitter)
        self.pages.addWidget(self.editor)
        self.modes = QButtonGroup(self)
        mode_bar = QHBoxLayout()
        for i, label in enumerate(("Banques", "Preset", "Global")):
            btn = QPushButton(label, checkable=True)
            btn.setMinimumWidth(btn.fontMetrics().horizontalAdvance("M" * 8))
            self.modes.addButton(btn, i)
            mode_bar.addWidget(btn)
        self.modes.button(2).setEnabled(False)
        self.modes.button(2).setToolTip("Réglages globaux : prévu après les essais sur le G-System")
        mode_bar.addStretch(1)
        self.modes.idClicked.connect(self.set_mode)
        central = QWidget()
        central_layout = QVBoxLayout(central)
        central_layout.addLayout(mode_bar)
        central_layout.addWidget(self.pages, 1)
        self.setCentralWidget(central)
        self.set_mode(0)

        self.midi_panel = MidiPanel(self)
        dock = QDockWidget("MIDI", self)
        dock.setObjectName("midi")
        dock.setWidget(self.midi_panel)
        self.addDockWidget(Qt.RightDockWidgetArea, dock)
        self.resizeDocks([dock], [380], Qt.Horizontal)

        self.build_menus(dock)
        geometry = self.settings.value("geometry")
        if geometry:
            self.restoreGeometry(geometry)
        else:
            self.resize(1600, 950)
        self.apply_zoom(float(self.settings.value("zoom", 1.3)))
        self.update_title()

    # Menus

    def action(self, text: str, slot, shortcut=None) -> QAction:
        act = QAction(text, self)
        if shortcut is not None:
            act.setShortcut(QKeySequence(shortcut))
        act.triggered.connect(slot)
        return act

    def build_menus(self, midi_dock: QDockWidget) -> None:
        file_menu = self.menuBar().addMenu("&Fichier")
        file_menu.addAction(self.action("&Ouvrir…", self.open_file, QKeySequence.Open))
        file_menu.addAction(self.action("&Enregistrer", self.save, QKeySequence.Save))
        file_menu.addAction(self.action("Enregistrer &sous…", self.save_as, QKeySequence.SaveAs))
        file_menu.addSeparator()
        file_menu.addAction(self.action("&Importer un .syx dans la banque…", self.import_syx))
        file_menu.addAction(self.action("E&xporter la banque en .syx…", lambda: self.export_syx(False)))
        file_menu.addAction(self.action("Exporter la sélection en .syx…", lambda: self.export_syx(True)))
        file_menu.addSeparator()
        file_menu.addAction(self.action("&Quitter", self.close, QKeySequence.Quit))

        edit = self.menuBar().addMenu("É&dition")
        undo = self.undo_group.createUndoAction(self, "Annuler")
        undo.setShortcut(QKeySequence.Undo)
        redo = self.undo_group.createRedoAction(self, "Rétablir")
        redo.setShortcut(QKeySequence.Redo)
        edit.addAction(undo)
        edit.addAction(redo)
        edit.addSeparator()
        edit.addAction(self.action("&Copier", self.copy_slots, QKeySequence.Copy))
        edit.addAction(self.action("Co&ller", self.paste_slots, QKeySequence.Paste))
        edit.addAction(self.action("&Vider les emplacements", self.clear_slots, QKeySequence.Delete))
        edit.addAction(self.action("&Renommer", self.rename_current, "F2"))

        view = self.menuBar().addMenu("&Affichage")
        view.addAction(self.action("Agrandir", lambda: self.step_zoom(1), QKeySequence.ZoomIn))
        view.addAction(self.action("Agrandir", lambda: self.step_zoom(1), "Ctrl+="))
        view.addAction(self.action("Réduire", lambda: self.step_zoom(-1), QKeySequence.ZoomOut))
        view.addAction(self.action("Taille normale", lambda: self.apply_zoom(1.3), "Ctrl+0"))
        view.addSeparator()
        view.addAction(midi_dock.toggleViewAction())

        about = self.menuBar().addMenu("&Aide")
        about.addAction(self.action("À propos", lambda: QMessageBox.about(
            self, "G-System Editor",
            f"G-System Editor {__version__}\nÉditeur libre pour TC Electronic G-System.")))

    # Zoom

    def apply_zoom(self, factor: float) -> None:
        self.zoom = factor
        font = QFont(QApplication.font())
        font.setPointSizeF(self.base_point_size * factor)
        QApplication.setFont(font)
        for widget in self.findChildren(QWidget):
            widget.setFont(font)
        self.editor.rescale(font)
        self.detail.rescale(font)
        self.detail.show_preset(*self.current_slot_and_preset())
        self.table.resizeRowsToContents()
        # Room for a full 20-character name plus number and status columns.
        self.table.setMinimumWidth(self.table.fontMetrics().horizontalAdvance("M" * 34))
        self.settings.setValue("zoom", factor)

    def step_zoom(self, direction: int) -> None:
        idx = min(range(len(ZOOM_STEPS)), key=lambda i: abs(ZOOM_STEPS[i] - self.zoom))
        idx = max(0, min(len(ZOOM_STEPS) - 1, idx + direction))
        self.apply_zoom(ZOOM_STEPS[idx])

    # Selection

    def selected_slots(self) -> list[int]:
        return sorted({index.row() for index in self.table.selectionModel().selectedRows()})

    def current_slot_and_preset(self) -> tuple[int | None, Preset | None]:
        index = self.table.currentIndex()
        if not index.isValid():
            return None, None
        return index.row(), self.model.preset(index.row())

    def set_live_available(self, available: bool) -> None:
        self.editor.send_param = self.midi_panel.reader.send_param if available else None
        self.editor.live.setEnabled(available)
        if not available:
            self.editor.live.setChecked(False)

    def set_block_ids(self, block_ids: dict[str, int]) -> None:
        self.editor.block_ids = dict(block_ids)
        self.settings.setValue("block_ids", json.dumps(block_ids))

    def set_mode(self, mode: int) -> None:
        self.modes.button(mode).setChecked(True)
        self.pages.setCurrentIndex(mode)
        self.undo_group.setActiveStack(self.editor.undo_stack if mode == 1 else self.model.undo_stack)

    def show_preset(self, slot: int) -> None:
        self.editor.open_slot(slot)
        self.set_mode(1)

    def on_current_changed(self, index) -> None:
        if index.isValid():
            self.detail.show_preset(index.row(), self.model.preset(index.row()))

    # Editing

    def confirm_overwrite(self, changes: dict[int, Preset | None]) -> bool:
        lost = [f"{slot_label(s)}  {self.model.preset(s).name}"
                for s in sorted(changes) if self.model.preset(s) is not None
                and (changes[s] is None or changes[s].data != self.model.preset(s).data)]
        if not lost:
            return True
        shown = "\n".join(lost[:15]) + ("\n…" if len(lost) > 15 else "")
        answer = QMessageBox.question(
            self, "Remplacer des presets ?",
            f"{len(lost)} preset(s) existant(s) vont être remplacés :\n\n{shown}\n\n"
            "Vous pourrez annuler avec Ctrl+Z.")
        return answer == QMessageBox.Yes

    def copy_slots(self) -> None:
        self.clipboard = [self.model.preset(s) for s in self.selected_slots()]

    def paste_slots(self) -> None:
        index = self.table.currentIndex()
        if not self.clipboard or not index.isValid():
            return
        start = index.row()
        changes = {start + i: p for i, p in enumerate(self.clipboard) if start + i < USER_SLOTS}
        if self.confirm_overwrite(changes):
            self.model.set_slots(changes, f"Coller {len(changes)} preset(s)")

    def clear_slots(self) -> None:
        changes = {s: None for s in self.selected_slots()}
        if self.confirm_overwrite(changes):
            self.model.set_slots(changes, f"Vider {len(changes)} emplacement(s)")

    def rename_current(self) -> None:
        index = self.table.currentIndex()
        if index.isValid():
            self.table.edit(self.model.index(index.row(), COL_NAME))

    # Files

    def last_dir(self) -> str:
        return str(self.settings.value("last_dir", Path.home() / "Documents/Psicraft/Vyzor G-System"))

    def resolve_pending_edit(self) -> bool:
        """Ask what to do with an edited but unstored preset. False means cancel."""
        if self.editor.is_dirty():
            self.set_mode(1)
            answer = QMessageBox.question(
                self, "Preset non stocké",
                f"Le preset « {self.editor.buffer.name} » a été modifié sans être stocké. Le stocker ?",
                QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel)
            if answer == QMessageBox.Cancel:
                return False
            if answer == QMessageBox.Save:
                self.editor.store()
            else:
                self.editor.revert()
        return True

    def maybe_discard(self) -> bool:
        if not self.resolve_pending_edit():
            return False
        if self.model.undo_stack.isClean():
            return True
        answer = QMessageBox.question(
            self, "Modifications non enregistrées",
            "La banque a été modifiée. Abandonner les modifications ?")
        return answer == QMessageBox.Yes

    def open_file(self) -> None:
        if not self.maybe_discard():
            return
        path, _ = QFileDialog.getOpenFileName(self, "Ouvrir une banque", self.last_dir(), FILE_FILTER)
        if path:
            self.load(Path(path))

    def load(self, path: Path) -> None:
        try:
            library = Library.load(path)
        except (OSError, ValueError) as exc:
            QMessageBox.critical(self, "Ouverture impossible", f"{path.name} :\n{exc}")
            return
        self.settings.setValue("last_dir", str(path.parent))
        self.model.set_library(library)
        self.table.resizeRowsToContents()
        self.table.selectRow(0)
        self.update_title()
        bad = sum(1 for p in library.presets if p is not None and not p.checksum_ok)
        used = sum(p is not None for p in library.presets)
        self.statusBar().showMessage(f"{used} presets chargés"
                                     + (f", {bad} avec une somme de contrôle invalide" if bad else ""))

    def load_from_device(self, presets: list[Preset]) -> None:
        slots: list[Preset | None] = [None] * USER_SLOTS
        for p in presets:
            if p.user_slot is not None:
                slots[p.user_slot] = p
        self.model.set_library(Library(slots))
        self.device_read_at = datetime.now()
        self.table.selectRow(0)
        self.update_title()
        self.set_mode(0)
        self.statusBar().showMessage(f"{len(presets)} presets lus depuis le G-System. "
                                     "Pensez à les enregistrer (Fichier → Exporter la banque en .syx).")

    def save(self) -> None:
        if not self.resolve_pending_edit():
            return
        lib = self.model.library
        if lib.sqs is None or lib.path is None:
            self.save_as()
            return
        self.write_sqs(lib.path)

    def save_as(self) -> None:
        if not self.resolve_pending_edit():
            return
        lib = self.model.library
        if lib.sqs is None:
            self.export_syx(False)
            return
        path, _ = QFileDialog.getSaveFileName(self, "Enregistrer la banque", str(lib.path), "Banque Vyzor (*.sqs)")
        if path:
            self.write_sqs(Path(path))

    def write_sqs(self, path: Path) -> None:
        try:
            self.model.library.save_sqs(path)
        except (OSError, SysexError) as exc:
            QMessageBox.critical(self, "Enregistrement impossible", str(exc))
            return
        self.model.library.path = path
        self.model.undo_stack.setClean()
        self.statusBar().showMessage(f"Enregistré dans {path} (copie de sauvegarde .bak créée)")

    def export_syx(self, selection_only: bool) -> None:
        if not self.resolve_pending_edit():
            return
        slots = self.selected_slots() if selection_only else None
        name = (self.model.library.path.stem if self.model.library.path else "banque") + ".syx"
        path, _ = QFileDialog.getSaveFileName(self, "Exporter en SysEx", str(Path(self.last_dir()) / name),
                                              "SysEx (*.syx)")
        if path:
            self.model.library.export_syx(Path(path), slots)
            self.statusBar().showMessage(f"Exporté vers {path}")

    def import_syx(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Importer des presets", self.last_dir(), "SysEx (*.syx *.SYX)")
        if not path:
            return
        presets = read_syx(Path(path))
        changes = {p.user_slot: p for p in presets if p.user_slot is not None}
        if not changes:
            QMessageBox.information(self, "Import", "Aucun preset utilisateur trouvé dans ce fichier.")
            return
        if self.confirm_overwrite(changes):
            self.model.set_slots(changes, f"Importer {len(changes)} preset(s)")

    def update_title(self, *_args) -> None:
        path = self.model.library.path
        dirty = "" if self.model.undo_stack.isClean() else " *"
        if path is not None:
            title = path.name
        elif getattr(self, "device_read_at", None) and self.model.library.sqs is None:
            title = f"G-System (lu à {self.device_read_at:%H:%M})"
        else:
            title = "Nouvelle banque"
        self.setWindowTitle(f"{title}{dirty} — G-System Editor")

    def closeEvent(self, event) -> None:
        if not self.maybe_discard():
            event.ignore()
            return
        self.midi_panel.shutdown()
        self.settings.setValue("geometry", self.saveGeometry())
        event.accept()


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("G-System Editor")
    MainWindow.base_point_size = app.font().pointSizeF()
    window = MainWindow()
    if len(sys.argv) > 1:
        window.load(Path(sys.argv[1]))
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
