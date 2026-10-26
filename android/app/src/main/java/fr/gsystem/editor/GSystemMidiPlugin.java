package fr.gsystem.editor;

import android.content.Context;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * USB MIDI for the web layer, built on android.media.midi.
 *
 * Bytes received from the device are forwarded as "data" events in the chunks
 * Android delivers them; the JavaScript side reassembles SysEx messages.
 */
@CapacitorPlugin(name = "GSystemMidi")
public class GSystemMidiPlugin extends Plugin {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MidiManager manager;
    private MidiDevice device;
    private MidiInputPort toDevice;
    private MidiOutputPort fromDevice;

    @Override
    public void load() {
        manager = (MidiManager) getContext().getSystemService(Context.MIDI_SERVICE);
    }

    private List<MidiDeviceInfo> devices() {
        List<MidiDeviceInfo> out = new ArrayList<>();
        if (manager == null) {
            return out;
        }
        Collection<MidiDeviceInfo> all;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            all = manager.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM);
        } else {
            all = java.util.Arrays.asList(manager.getDevices());
        }
        for (MidiDeviceInfo info : all) {
            // We need to talk both ways: one port to the device, one from it.
            if (info.getInputPortCount() > 0 && info.getOutputPortCount() > 0) {
                out.add(info);
            }
        }
        return out;
    }

    private static String nameOf(MidiDeviceInfo info) {
        Bundle props = info.getProperties();
        String name = props.getString(MidiDeviceInfo.PROPERTY_NAME);
        if (name == null) {
            name = props.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "MIDI " + info.getId());
        }
        return name;
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        JSArray list = new JSArray();
        for (MidiDeviceInfo info : devices()) {
            JSObject d = new JSObject();
            d.put("id", String.valueOf(info.getId()));
            d.put("name", nameOf(info));
            list.put(d);
        }
        JSObject result = new JSObject();
        result.put("devices", list);
        call.resolve(result);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        MidiDeviceInfo target = null;
        for (MidiDeviceInfo info : devices()) {
            if (String.valueOf(info.getId()).equals(id)) {
                target = info;
            }
        }
        if (target == null) {
            call.reject("Appareil MIDI introuvable");
            return;
        }
        closeAll();
        manager.openDevice(target, opened -> {
            if (opened == null) {
                call.reject("Impossible d'ouvrir l'appareil MIDI");
                return;
            }
            device = opened;
            toDevice = opened.openInputPort(0);
            fromDevice = opened.openOutputPort(0);
            if (toDevice == null || fromDevice == null) {
                closeAll();
                call.reject("Ports MIDI indisponibles");
                return;
            }
            fromDevice.connect(new MidiReceiver() {
                @Override
                public void onSend(byte[] msg, int offset, int count, long timestamp) {
                    JSArray data = new JSArray();
                    for (int i = 0; i < count; i++) {
                        data.put(msg[offset + i] & 0xFF);
                    }
                    JSObject event = new JSObject();
                    event.put("data", data);
                    notifyListeners("data", event);
                }
            });
            call.resolve();
        }, handler);
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (toDevice == null) {
            call.reject("Pas d'appareil MIDI ouvert");
            return;
        }
        JSArray data = call.getArray("data");
        byte[] bytes = new byte[data.length()];
        try {
            for (int i = 0; i < bytes.length; i++) {
                bytes[i] = (byte) data.getInt(i);
            }
            int max = Math.max(1, toDevice.getMaxMessageSize());
            for (int offset = 0; offset < bytes.length; offset += max) {
                toDevice.send(bytes, offset, Math.min(max, bytes.length - offset));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Envoi MIDI impossible : " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        closeAll();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        closeAll();
    }

    private void closeAll() {
        try {
            if (fromDevice != null) {
                fromDevice.close();
            }
            if (toDevice != null) {
                toDevice.close();
            }
            if (device != null) {
                device.close();
            }
        } catch (IOException ignored) {
            // Closing a device that was unplugged can fail; nothing to recover.
        }
        fromDevice = null;
        toDevice = null;
        device = null;
    }
}
