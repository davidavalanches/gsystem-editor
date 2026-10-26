"""MIDI link to the G-System via rtmidi (ALSA on Linux, CoreMIDI on macOS).

Messages used, all observed on the hardware:

- Universal Device Inquiry, answered with the firmware version.
- ``55 45 01 <num>``: request a stored preset (read-only), answered by a dump.
- ``55 22 <block> <param:2> <value:6 nibbles>``: set one parameter of the edit
  buffer. The unit sends the same message when a switch or knob is used.
  Writing needs SysEx ID 7F; nothing is stored until Store is pressed.
- Bank Select + Program Change: sent by the unit when a preset is recalled.
  Over USB the unit ignores incoming Program Changes, so the editor auditions
  a preset by writing its parameters into the edit buffer instead.
"""

from __future__ import annotations

from collections import deque

from PySide6.QtCore import QObject, QTimer, Signal

from .sysex import MODEL_G_SYSTEM, TC_MANUFACTURER, USER_PRESET_BASE, USER_SLOTS, Preset, is_preset_dump

try:
    import rtmidi
except ImportError:  # pragma: no cover - reported in the UI
    rtmidi = None

DEVICE_INQUIRY = bytes.fromhex("F07E7F0601F7")
REQUEST_PRESET = 0x45
SET_PARAM = 0x22
WRITE_DEVICE_ID = 0x7F
# The unit answers a preset request in about 0.77 s and ignores requests while busy;
# empty slots do not answer at all.
REQUEST_TIMEOUT_MS = 1100


USER_BANK_SIZE = 100  # Bank Select (CC 0) 1 = user presets 1-100, 2 = 101-200
SEND_INTERVAL_MS = 2  # pacing for bursts of parameter messages

# Block ids of the 55 22 parameter message, captured from the unit's switches and knobs.
# Block 1 is the levels table (loops, insert, boost).
BLOCK_IDS = {"eq": 2, "mod": 4, "filter": 7, "pitch": 8, "delay": 9, "comp": 10, "reverb": 11, "gate": 12}


def param_message(block_id: int, param: int, value: int) -> bytes:
    raw = value & 0xFFFFFF
    nibbles = bytes((raw >> shift) & 0x0F for shift in range(20, -1, -4))
    return bytes((0xF0, *TC_MANUFACTURER, WRITE_DEVICE_ID, MODEL_G_SYSTEM, SET_PARAM, block_id,
                  param >> 7, param & 0x7F)) + nibbles + b"\xf7"


def parse_param_message(msg: bytes) -> tuple[int, int, int] | None:
    """(block id, parameter, value) of a 55 22 message, else None."""
    if len(msg) != 17 or msg[1:4] != TC_MANUFACTURER or msg[5] != MODEL_G_SYSTEM or msg[6] != SET_PARAM:
        return None
    raw = 0
    for nibble in msg[10:16]:
        raw = raw << 4 | (nibble & 0x0F)
    value = raw - (1 << 24) if raw & 0x800000 else raw
    return msg[7], msg[8] << 7 | msg[9], value


def preset_request(number: int, device_id: int = 0) -> bytes:
    return bytes((0xF0, *TC_MANUFACTURER, device_id, MODEL_G_SYSTEM, REQUEST_PRESET, 0x01,
                  number >> 7, number & 0x7F, 0xF7))


def is_gsystem_identity(msg: bytes) -> bool:
    return msg[:2] == b"\xf0\x7e" and msg[3:5] == b"\x06\x02" and msg[5:8] == TC_MANUFACTURER \
        and msg[8] == MODEL_G_SYSTEM


class MidiInput(QObject):
    # Emitted from the rtmidi thread; Qt queues it to the GUI thread.
    message = Signal(bytes)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._port = None
        self.port_name: str | None = None

    @staticmethod
    def available() -> bool:
        return rtmidi is not None

    @staticmethod
    def ports() -> list[str]:
        if rtmidi is None:
            return []
        probe = rtmidi.MidiIn()
        try:
            return probe.get_ports()
        finally:
            probe.delete()

    def open(self, index: int) -> None:
        self.close()
        port = rtmidi.MidiIn()
        port.ignore_types(sysex=False, timing=True, active_sense=True)
        port.open_port(index)
        port.set_callback(self._on_message)
        self._port = port
        self.port_name = port.get_port_name(index)

    def close(self) -> None:
        if self._port is not None:
            self._port.cancel_callback()
            self._port.close_port()
            self._port.delete()
        self._port = None
        self.port_name = None

    def _on_message(self, event, _data=None) -> None:
        msg, _delta = event
        self.message.emit(bytes(msg))


class GSystemReader(QObject):
    """Requests to the unit: identification, preset reading and parameter changes."""

    progress = Signal(int, int)  # done, total
    param_changed = Signal(int, int, int)  # block id, parameter, value — sent by the unit
    preset_selected = Signal(int)  # user slot recalled on the unit
    preset_received = Signal(object)  # Preset
    finished = Signal(list, list)  # presets, numbers without reply

    def __init__(self, midi_in: MidiInput, parent=None) -> None:
        super().__init__(parent)
        self.midi_in = midi_in
        self._out = None
        self._queue: deque[int] = deque()
        self._current: int | None = None
        self._received: list[Preset] = []
        self._missing: list[int] = []
        self._total = 0
        # MIDI channel the unit uses; learned from its own messages.
        self.channel = 0
        self._bank: int | None = None
        self._send_queue: deque[bytes] = deque()
        self._send_timer = QTimer(self, interval=SEND_INTERVAL_MS)
        self._send_timer.timeout.connect(self._drain)
        self._timer = QTimer(self, singleShot=True)
        self._timer.timeout.connect(self._timed_out)
        midi_in.message.connect(self._on_message)

    @property
    def busy(self) -> bool:
        return self._current is not None

    def open_output(self, port_name: str) -> None:
        self.close_output()
        out = rtmidi.MidiOut()
        names = out.get_ports()
        out.open_port(names.index(port_name))
        self._out = out

    def close_output(self) -> None:
        self._send_queue.clear()
        self._send_timer.stop()
        if self._out is not None:
            self._out.close_port()
            self._out.delete()
        self._out = None

    def send_param(self, block_id: int, param: int, value: int) -> None:
        """Queue a parameter change; bursts (a whole preset) are paced."""
        if self._out is None:
            return
        self._send_queue.append(param_message(block_id, param, value))
        if not self._send_timer.isActive():
            self._send_timer.start()

    def _drain(self) -> None:
        if not self._send_queue or self._out is None:
            self._send_timer.stop()
            return
        self._out.send_message(list(self._send_queue.popleft()))

    def identify(self) -> None:
        self._out.send_message(list(DEVICE_INQUIRY))

    def read_bank(self, slots=range(USER_SLOTS)) -> None:
        self._queue = deque(USER_PRESET_BASE + s for s in slots)
        self._total = len(self._queue)
        self._received, self._missing = [], []
        self._next()

    def cancel(self) -> None:
        self._queue.clear()
        self._timer.stop()
        self._finish()

    def _next(self) -> None:
        if not self._queue:
            self._finish()
            return
        self._current = self._queue.popleft()
        self._out.send_message(list(preset_request(self._current)))
        self._timer.start(REQUEST_TIMEOUT_MS)

    def _finish(self) -> None:
        self._current = None
        self.finished.emit(self._received, self._missing)

    def _on_message(self, msg: bytes) -> None:
        status = msg[0] & 0xF0 if msg else 0
        if status == 0xB0 and len(msg) == 3 and msg[1] == 0x00:
            self.channel, self._bank = msg[0] & 0x0F, msg[2]
            return
        if status == 0xC0 and len(msg) == 2:
            self.channel = msg[0] & 0x0F
            if self._bank in (1, 2):
                self.preset_selected.emit((self._bank - 1) * USER_BANK_SIZE + msg[1])
            return
        change = parse_param_message(msg)
        if change is not None:
            self.param_changed.emit(*change)
            return
        if self._current is None or not is_preset_dump(msg):
            return
        preset = Preset.from_sysex(msg, strict=False)
        if preset.number != self._current:
            return
        self._timer.stop()
        self._received.append(preset)
        self.preset_received.emit(preset)
        self.progress.emit(self._total - len(self._queue), self._total)
        self._next()

    def _timed_out(self) -> None:
        # Empty slots do not answer.
        self._missing.append(self._current)
        self.progress.emit(self._total - len(self._queue), self._total)
        self._next()

