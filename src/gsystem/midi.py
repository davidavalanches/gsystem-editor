"""MIDI input via rtmidi (ALSA on Linux, CoreMIDI on macOS).

Receive-only for now: nothing is ever sent to the unit until the transfer
protocol has been validated on real hardware.
"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal

try:
    import rtmidi
except ImportError:  # pragma: no cover - reported in the UI
    rtmidi = None


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
