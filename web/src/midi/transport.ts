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
  /** Every port name, for diagnostics. */
  describe?(): Promise<string>;
}

interface GSystemMidiPlugin {
  listDevices(): Promise<{ devices: PortInfo[] }>;
  open(options: { id: string }): Promise<void>;
  send(options: { data: number[] }): Promise<void>;
  close(): Promise<void>;
  addListener(event: "data", cb: (e: { data: number[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: "lost", cb: () => void): Promise<PluginListenerHandle>;
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
      onLost: null,
      send: (msg) => void NativeMidi.send({ data: Array.from(msg) }),
      close: () => {
        void handle.then((h) => h.remove());
        void lost.then((h) => h.remove());
        void NativeMidi.close();
      },
    };
    // The native side delivers raw byte chunks; SysEx may be split.
    const parser = new MidiParser((msg) => transport.onMessage?.(msg));
    const handle = NativeMidi.addListener("data", (e) => parser.push(e.data));
    // Sent when Android reports the open device removed; the native side has closed it.
    const lost = NativeMidi.addListener("lost", () => {
      transport.close();
      transport.onLost?.();
    });
    return transport;
  }
}

/**
 * The key pairing an input with the output of the same device. Names usually match exactly, but
 * Windows may write "MIDIIN2 (G-System)" / "MIDIOUT2 (G-System)", and some drivers add "In" / "Out".
 */
export function portKey(name: string): string {
  return name
    .trim()
    .replace(/^midi(?:in|out)(\d*)\s*\((.*)\)$/i, "$2 $1")
    .replace(/[\s_-]*\b(?:in|out|input|output)\b(?=\s*(?:\d*\s*)$)/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The input of the same device as this output: same name, else same {@link portKey}. */
function inputFor(output: MIDIOutput, inputs: MIDIInput[]): MIDIInput | undefined {
  const name = output.name ?? "";
  return inputs.find((i) => i.name === name) ?? inputs.find((i) => portKey(i.name ?? "") === portKey(name));
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
    // Only outputs that have an input of the same device can carry a request and its answer.
    const inputs = [...midi.inputs.values()];
    return [...midi.outputs.values()]
      .filter((o) => inputFor(o, inputs))
      .map((o) => ({ id: o.name ?? o.id, name: o.name ?? o.id }));
  }

  /** Every port name, for diagnostics. */
  async describe(): Promise<string> {
    const midi = await this.midi();
    const names = (ports: Iterable<MIDIPort>) => [...ports].map((p) => p.name ?? p.id).join(", ") || "none";
    return `inputs: ${names(midi.inputs.values())}; outputs: ${names(midi.outputs.values())}`;
  }

  async open(id: string): Promise<Transport> {
    const midi = await this.midi();
    const output = [...midi.outputs.values()].find((o) => (o.name ?? o.id) === id);
    const input = output && inputFor(output, [...midi.inputs.values()]);
    if (!output || !input) throw new Error(`MIDI port not found: ${id}`);
    await Promise.all([output.open(), input.open()]);
    // Unplugging the device disconnects its ports.
    const onState = (e: Event) => {
      const port = (e as MIDIConnectionEvent).port;
      if ((port === input || port === output) && port.state === "disconnected") {
        transport.close();
        transport.onLost?.();
      }
    };
    midi.addEventListener("statechange", onState);
    const transport: Transport = {
      onMessage: null,
      onLost: null,
      send: (msg) => output.send(msg),
      close: () => {
        midi.removeEventListener("statechange", onState);
        input.onmidimessage = null;
        void input.close();
        void output.close();
      },
    };
    // Messages normally arrive whole, but some systems (CoreMIDI on macOS) may split a SysEx
    // or join several messages in one event: rebuild complete messages from the bytes.
    const parser = new MidiParser((msg) => transport.onMessage?.(msg));
    input.onmidimessage = (e) => {
      if (e.data) parser.push(e.data);
    };
    return transport;
  }
}

export function midiAccess(): MidiAccess {
  return Capacitor.getPlatform() === "android" ? new AndroidMidi() : new WebMidi();
}
