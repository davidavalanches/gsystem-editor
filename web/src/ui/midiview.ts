/** MIDI view: connection to the G-System and reading the bank. */

import { el } from "./dom";

export class MidiView {
  readonly el = el("section", "view");
  private readonly dot = el("span", "dot");
  private readonly state = el("span", "", "Not connected");
  private readonly detail = el("p", "", "Plug in the G-System, then tap “Connect”.");
  readonly connectButton = el("button", "pill primary", "Connect");
  readonly readAllButton = el("button", "pill", "READ ALL BANKS");
  readonly readBankButton = el("button", "pill", "Read bank shown");
  /** The unit's SysEx ID (Global › MIDI › SysEx ID on the G-System), needed to store presets. */
  readonly sysexId = el("input", "sysex-id");
  private readonly body = el("div", "midi-body");
  private readonly help = el("div", "card");

  constructor() {
    for (const b of [this.connectButton, this.readAllButton, this.readBankButton]) b.type = "button";
    this.readAllButton.disabled = this.readBankButton.disabled = true;
    const header = el("header", "header");
    header.append(el("div", "grow header-title", "MIDI"));

    const status = el("div", "card");
    const line = el("div", "status-line");
    line.append(this.dot, this.state);
    const actions = el("div", "actions");
    actions.append(this.connectButton, this.readAllButton, this.readBankButton);
    this.sysexId.type = "number";
    this.sysexId.min = "0";
    this.sysexId.max = "126";
    this.sysexId.inputMode = "numeric";
    const idRow = el("label", "sysex-row", "G-System SysEx ID");
    idRow.append(this.sysexId);
    idRow.title = "The unit's Global › MIDI › SysEx ID setting (1 by default). Needed for Store.";
    status.append(el("h2", "", "G-System"), line, this.detail, actions, idRow);

    const help = this.help;
    help.append(
      el("h2", "", "How to use"),
      el("p", "", "On a phone, connect the G-System's USB port with an OTG cable: the phone acts as the USB host."),
      el("p", "", "“READ ALL BANKS” requests the 200 presets one by one (about 2 min 30 s); "
        + "the list fills in as they arrive."),
      el("p", "", "“Live” (Preset view) sends each setting to the G-System's working memory without storing anything. "
        + "Changing preset with your foot makes the editor follow."),
    );
    this.body.append(status, help);
    this.el.append(header, this.body);
  }

  /** A card of the unit's settings (its MIDI menu), after the connection card. */
  addCard(card: HTMLElement): void {
    this.body.insertBefore(card, this.help);
  }

  setStatus(text: string, connected: boolean, detail = ""): void {
    this.state.textContent = text;
    this.dot.className = connected ? "dot on" : "dot";
    this.detail.textContent = detail;
    this.connectButton.textContent = connected ? "Disconnect" : "Connect";
    this.connectButton.className = connected ? "pill" : "pill primary";
    this.readAllButton.disabled = this.readBankButton.disabled = !connected;
  }
}
