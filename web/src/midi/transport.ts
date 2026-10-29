/**
 * MIDI access on each platform:
 * - Android (Capacitor): the native GSystemMidi plugin, built on android.media.midi;
 * - browsers (Chrome/Chromium on Linux, macOS, Windows): Web MIDI with SysEx.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { MidiParser, type Transport } from "../core/protocol";

export interface PortInfo {
  id: string;
  name: string;
}

export interface MidiAccess {
  listPorts(): Promise<PortInfo[]>;
  open(id: string): Promise<Transport>;
}

interface GSystemMidiPlugin {
  listDevices(): Promise<{ devices: PortInfo[] }>;
  open(options: { id: string }): Promise<void>;
  send(options: { data: number[] }): Promise<void>;
  close(): Promise<void>;
  addListener(event: "data", cb: (e: { data: number[] }) => void): Promise<PluginListenerHandle>;
}

const NativeMidi = registerPlugin<GSystemMidiPlugin>("GSystemMidi");

class AndroidMidi implements MidiAccess {
  async listPorts(): Promise<PortInfo[]> {
    return (await NativeMidi.listDevices()).devices;
  }

  async open(id: string): Promise<Transport> {
    await NativeMidi.open({ id });
    const transport: Transport = {
      onMessage: null,
      send: (msg) => void NativeMidi.send({ data: Array.from(msg) }),
      close: () => {
        void handle.then((h) => h.remove());
        void NativeMidi.close();
      },
    };
    // The native side delivers raw byte chunks; SysEx may be split.
    const parser = new MidiParser((msg) => transport.onMessage?.(msg));
    const handle = NativeMidi.addListener("data", (e) => parser.push(e.data));
    return transport;
  }
}

class WebMidi implements MidiAccess {
  private access: MIDIAccess | null = null;

  private async midi(): Promise<MIDIAccess> {
    if (!navigator.requestMIDIAccess) throw new Error("This browser does not support MIDI (use Chrome or Chromium).");
    this.access ??= await navigator.requestMIDIAccess({ sysex: true });
    return this.access;
  }

  async listPorts(): Promise<PortInfo[]> {
    const midi = await this.midi();
    return [...midi.outputs.values()].map((o) => ({ id: o.name ?? o.id, name: o.name ?? o.id }));
  }

  async open(id: string): Promise<Transport> {
    const midi = await this.midi();
    const output = [...midi.outputs.values()].find((o) => (o.name ?? o.id) === id);
    const input = [...midi.inputs.values()].find((i) => i.name === output?.name);
    if (!output || !input) throw new Error(`MIDI port not found: ${id}`);
    await Promise.all([output.open(), input.open()]);
    const transport: Transport = {
      onMessage: null,
      send: (msg) => output.send(msg),
      close: () => {
        input.onmidimessage = null;
        void input.close();
        void output.close();
      },
    };
    input.onmidimessage = (e) => {
      if (e.data) transport.onMessage?.(new Uint8Array(e.data));
    };
    return transport;
  }
}

export function midiAccess(): MidiAccess {
  return Capacitor.getPlatform() === "android" ? new AndroidMidi() : new WebMidi();
}
