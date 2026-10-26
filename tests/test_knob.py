import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
QtWidgets = pytest.importorskip("PySide6.QtWidgets")
from PySide6.QtCore import QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QWheelEvent  # noqa: E402

from gsystem.knob import Knob  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def wheel(knob, notches):
    event = QWheelEvent(QPointF(5, 5), QPointF(5, 5), QPoint(0, 0), QPoint(0, 120 * notches),
                        Qt.NoButton, Qt.NoModifier, Qt.NoScrollPhase, False)
    knob.wheelEvent(event)


def test_value_is_clamped(app):
    knob = Knob(-12, 12)
    knob.setValue(40)
    assert knob.value() == 12


def test_wheel_reports_final_value(app):
    knob = Knob(0, 10)
    released = []
    knob.released.connect(released.append)
    wheel(knob, 1)
    wheel(knob, 1)
    assert knob.value() == 2 and released == [1, 2]


def test_toggle_has_two_positions(app):
    knob = Knob(0, 1, toggle=True)
    released = []
    knob.released.connect(released.append)
    wheel(knob, 1)
    wheel(knob, 1)
    wheel(knob, -1)
    assert released == [1, 1, 0] and knob.value() == 0
