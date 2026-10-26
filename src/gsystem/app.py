"""G-System Editor main window."""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QFont, QKeySequence, QUndoGroup
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QButtonGroup,
    QComboBox,
    QDockWidget,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
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
from .params import BLOCKS, read_field
from .midi import BLOCK_IDS, GSystemReader, MidiInput, is_gsystem_identity
from .model import BankModel, Library, slot_label
from .sqs import read_syx
from .sysex import USER_PRESET_BASE, USER_SLOTS, Preset, SysexError

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
    """Readable summary of the selected preset: each effect with its type and state."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.title = QLabel()
        self.title.setWordWrap(True)
        self.info = QLabel()
        self.info.setWordWrap(True)
        self.info.setTextFormat(Qt.RichText)
        self.rescale(self.title.font())
        layout = QVBoxLayout(self)
        layout.addWidget(self.title)
        layout.addWidget(self.info)
        layout.addStretch(1)
        self.show_preset(None, None)

    def rescale(self, base: QFont) -> None:
        title_font = QFont(base)
        title_font.setPointSizeF(base.pointSizeF() * 1.6)
        title_font.setBold(True)
        self.title.setFont(title_font)

    def show_preset(self, slot: int | None, preset: Preset | None) -> None:
        if slot is None:
            self.title.setText("Aucune sélection")
            self.info.setText("")
            return
        if preset is None:
            self.title.setText(f"{slot_label(slot)} — vide")
            self.info.setText("")
            return
        self.title.setText(f"{slot_label(slot)} — {preset.name}")
        rows = []
        for blk in BLOCKS:
            kind = blk.effect_type(preset.data)
            enable = blk.enable_field(preset.data)
            on = enable is not None and read_field(preset.data, enable) == 1
            state = "<b style='color:#c0392b'>On</b>" if on else "<span style='color:#888'>Off</span>"
            rows.append(f"<tr><td>{blk.label}</td><td>{kind.name if kind else ''}</td><td>{state}</td></tr>")
        warnings = []
        if not preset.checksum_ok:
            warnings.append("⚠ Somme de contrôle invalide dans le fichier : elle sera corrigée à l'enregistrement.")
        if preset.user_slot != slot:
            warnings.append("⚠ Preset déplacé : il sera renuméroté à l'enregistrement.")
        self.info.setText("<table cellpadding='4'>" + "".join(rows) + "</table>"
                          + "".join(f"<p>{w}</p>" for w in warnings))


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
        self.reader.preset_received.connect(self.on_preset_read)
        self.read_mode: str | None = None
        self.reader.param_changed.connect(self.on_param_changed)
        self.reader.preset_selected.connect(self.on_unit_preset)

        self.ports = QComboBox()
        refresh = QPushButton("Actualiser")
        refresh.clicked.connect(self.refresh_ports)
        self.connect_button = QPushButton("Connecter", checkable=True)
        self.connect_button.toggled.connect(self.on_connect)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.read_button = QPushButton("Lire toute la banque")
        self.read_button.setToolTip("Demande les 200 presets utilisateur un par un (lecture seule, ~2 min 30). "
                                    "La liste se remplit au fur et à mesure.")
        self.read_button.clicked.connect(self.read_bank)
        self.read_button.setEnabled(False)
        self.read_selection_button = QPushButton("Lire la sélection")
        self.read_selection_button.setToolTip("Relit depuis le G-System seulement les emplacements sélectionnés "
                                              "dans la liste (0,8 s par preset)")
        self.read_selection_button.clicked.connect(self.read_selection)
        self.read_selection_button.setEnabled(False)
        self.progress = QProgressBar()
        self.progress.hide()

        row = QHBoxLayout()
        row.addWidget(self.ports, 1)
        row.addWidget(refresh)
        layout = QVBoxLayout(self)
        layout.addLayout(row)
        layout.addWidget(self.connect_button)
        layout.addWidget(self.status)
        read_row = QHBoxLayout()
        read_row.addWidget(self.read_button)
        read_row.addWidget(self.read_selection_button)
        layout.addLayout(read_row)
        layout.addWidget(self.progress)
        hint = QLabel("« Live » (mode Preset) modifie uniquement la mémoire de travail du G-System : "
                      "rien n'est stocké dans le pédalier. Changer de preset sur le G-System annule tout.")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        layout.addStretch(1)
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
            self.read_selection_button.setEnabled(False)
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
        self.window.editor.panel.flash_midi()
        if is_gsystem_identity(msg):
            version = f"{msg[14]}.{msg[15]:02d}"
            self.status.setText(f"G-System détecté (version {version}).")
            self.read_button.setEnabled(True)
            self.read_selection_button.setEnabled(True)
            self.window.set_live_available(True)

    def on_param_changed(self, block_id: int, param: int, value: int) -> None:
        self.window.editor.apply_from_unit(block_id, param, value)

    def read_bank(self) -> None:
        if self.reader.busy:
            self.reader.cancel()
            return
        if not self.window.maybe_discard():
            return
        self.window.start_device_read()
        self._start_read("all", range(USER_SLOTS))

    def read_selection(self) -> None:
        if self.reader.busy:
            self.reader.cancel()
            return
        slots = self.window.selected_slots()
        if not slots:
            QMessageBox.information(self, "Lire la sélection",
                                    "Sélectionnez d'abord des emplacements dans la liste (mode Banques).")
            return
        self._start_read("selection", slots)

    def _start_read(self, mode: str, slots) -> None:
        self.read_mode = mode
        button = self.read_button if mode == "all" else self.read_selection_button
        button.setText("Annuler la lecture")
        (self.read_selection_button if mode == "all" else self.read_button).setEnabled(False)
        self.progress.setRange(0, len(slots))
        self.progress.setValue(0)
        self.progress.show()
        self.reader.read_bank(slots)

    def on_unit_preset(self, slot: int) -> None:
        """A preset was recalled on the pedalboard: follow it and re-read it, so the
        editor shows exactly what the unit plays."""
        editor = self.window.editor
        if not editor.live.isChecked():
            return
        editor.follow_unit(slot)
        if not self.reader.busy:
            self.read_mode = "refresh"
            self.reader.read_bank([slot])

    def on_preset_read(self, preset: Preset) -> None:
        if self.read_mode == "all":
            self.window.device_preset_arrived(preset)

    def on_progress(self, done: int, total: int) -> None:
        self.progress.setValue(done)
        self.status.setText(f"Lecture du preset {done}/{total}…")

    def on_bank_read(self, presets: list, missing: list) -> None:
        mode, self.read_mode = self.read_mode, None
        if mode == "refresh":
            self._apply_refresh(presets, missing)
            return
        self.read_button.setText("Lire toute la banque")
        self.read_selection_button.setText("Lire la sélection")
        self.read_button.setEnabled(True)
        self.read_selection_button.setEnabled(True)
        self.progress.hide()
        if mode == "selection":
            changes = {p.user_slot: p for p in presets if p.user_slot is not None}
            changes.update({n - USER_PRESET_BASE: None for n in missing})
            if changes and self.window.confirm_overwrite(changes):
                self.window.model.set_slots(changes, f"Lecture de {len(changes)} emplacement(s) du G-System")
        self.status.setText(f"{len(presets)} presets lus, {len(missing)} emplacement(s) vide(s).")

    def _apply_refresh(self, presets: list, missing: list) -> None:
        model = self.window.model
        changes = {p.user_slot: p for p in presets if p.user_slot is not None}
        changes.update({n - USER_PRESET_BASE: None for n in missing})
        changes = {s: p for s, p in changes.items()
                   if (model.preset(s).data if model.preset(s) else None) != (p.data if p else None)}
        if changes:
            model.set_slots(changes, "Relu depuis le G-System")
            self.window.statusBar().showMessage("Preset mis à jour depuis le G-System (différent de la banque affichée).")

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
        self.table.setSelectionBehavior(QAbstractItemView.SelectItems)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        # Double-click opens the preset; F2 renames it.
        self.table.setEditTriggers(QAbstractItemView.EditKeyPressed)
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Stretch)
        self.table.selectionModel().currentChanged.connect(self.on_current_changed)
        self.model.dataChanged.connect(lambda *_: self.on_current_changed(self.table.currentIndex()))

        self.detail = DetailPanel()
        splitter = QSplitter()
        splitter.addWidget(self.table)
        splitter.addWidget(self.detail)
        splitter.setChildrenCollapsible(False)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([3000, 1000])
        self.splitter = splitter

        self.editor = PresetEditor(self.model)
        self.editor.notice.connect(lambda text: self.statusBar().showMessage(text, 8000))
        self.editor.block_ids = dict(BLOCK_IDS)
        self.editor.store_requested.connect(
            lambda slot, preset: self.model.set_slots({slot: preset}, f"Store « {preset.name} »"))
        self.model.dataChanged.connect(
            lambda top, _bottom: self.editor.reload_if_showing(self.model.slot_of(top)))
        self.model.modelReset.connect(lambda: self.editor.open_slot(0))
        self.table.doubleClicked.connect(lambda index: self.show_preset(self.model.slot_of(index)))

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
        dev = QAction("Outils de développement", self, checkable=True)
        dev.setToolTip("Vues Brut, Comparer et Modifiers (données non décodées)")
        dev.toggled.connect(self.editor.set_dev_tools)
        dev.toggled.connect(lambda on: self.settings.setValue("dev_tools", on))
        dev.setChecked(self.settings.value("dev_tools", False, type=bool))
        view.addAction(dev)

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
        # Room for five names of about 16 characters each.
        self.table.setMinimumWidth(self.table.fontMetrics().horizontalAdvance("x" * 16) * 5)
        self.settings.setValue("zoom", factor)

    def step_zoom(self, direction: int) -> None:
        idx = min(range(len(ZOOM_STEPS)), key=lambda i: abs(ZOOM_STEPS[i] - self.zoom))
        idx = max(0, min(len(ZOOM_STEPS) - 1, idx + direction))
        self.apply_zoom(ZOOM_STEPS[idx])

    # Selection

    def selected_slots(self) -> list[int]:
        return sorted({self.model.slot_of(index) for index in self.table.selectionModel().selectedIndexes()})

    def current_slot_and_preset(self) -> tuple[int | None, Preset | None]:
        index = self.table.currentIndex()
        if not index.isValid():
            return None, None
        slot = self.model.slot_of(index)
        return slot, self.model.preset(slot)

    def set_live_available(self, available: bool) -> None:
        self.editor.send_param = self.midi_panel.reader.send_param if available else None
        self.editor.live.setEnabled(available)
        if not available:
            self.editor.live.setChecked(False)

    def set_mode(self, mode: int) -> None:
        self.modes.button(mode).setChecked(True)
        self.pages.setCurrentIndex(mode)
        self.undo_group.setActiveStack(self.editor.undo_stack if mode == 1 else self.model.undo_stack)

    def show_preset(self, slot: int) -> None:
        self.editor.open_slot(slot)
        self.set_mode(1)

    def on_current_changed(self, index) -> None:
        if index.isValid():
            slot = self.model.slot_of(index)
            self.detail.show_preset(slot, self.model.preset(slot))

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
        start = self.model.slot_of(index)
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
            self.table.edit(index)

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
        self.table.setCurrentIndex(self.model.slot_index(0))
        self.update_title()
        bad = sum(1 for p in library.presets if p is not None and not p.checksum_ok)
        used = sum(p is not None for p in library.presets)
        self.statusBar().showMessage(f"{used} presets chargés"
                                     + (f", {bad} avec une somme de contrôle invalide" if bad else ""))

    def start_device_read(self) -> None:
        """Start from an empty bank that fills up as presets arrive from the unit."""
        self.model.set_library(Library())
        self.device_read_at = datetime.now()
        self.update_title()
        self.set_mode(0)
        self.statusBar().showMessage("Lecture du G-System… Pensez ensuite à exporter la banque en .syx.")

    def device_preset_arrived(self, preset: Preset) -> None:
        slot = preset.user_slot
        if slot is not None:
            self.model.library.presets[slot] = preset
            self.model.slot_changed(slot)

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
