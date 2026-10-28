/** MIDI view: connection to the G-System and reading the bank. */

import { el } from "./dom";

export class MidiView {
  readonly el = el("section", "view");
  private readonly dot = el("span", "dot");
  private readonly state = el("span", "", "Non connecté");
  private readonly detail = el("p", "", "Branchez le G-System puis touchez « Connecter ».");
  readonly connectButton = el("button", "pill primary", "Connecter");
  readonly readAllButton = el("button", "pill", "Lire toute la banque");
  readonly readBankButton = el("button", "pill", "Lire la banque affichée");
  /** The unit's SysEx ID (Global › MIDI › SysEx ID on the G-System), needed to store presets. */
  readonly sysexId = el("input", "sysex-id");

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
    const idRow = el("label", "sysex-row", "SysEx ID du G-System");
    idRow.append(this.sysexId);
    idRow.title = "Réglage Global › MIDI › SysEx ID du pédalier (1 par défaut). Nécessaire pour Store.";
    status.append(el("h2", "", "G-System"), line, this.detail, actions, idRow);

    const help = el("div", "card");
    help.append(
      el("h2", "", "Mode d'emploi"),
      el("p", "", "Sur téléphone, reliez le port USB du G-System avec un câble OTG : le téléphone fait office d'hôte USB."),
      el("p", "", "« Lire toute la banque » demande les 200 presets un par un (environ 2 min 30) ; "
        + "la liste se remplit au fur et à mesure."),
      el("p", "", "« Live » (vue Preset) envoie chaque réglage dans la mémoire de travail du G-System sans rien stocker. "
        + "Changer de preset au pied fait suivre l'éditeur."),
    );
    const body = el("div", "midi-body");
    body.append(status, help);
    this.el.append(header, body);
  }

  setStatus(text: string, connected: boolean, detail = ""): void {
    this.state.textContent = text;
    this.dot.className = connected ? "dot on" : "dot";
    this.detail.textContent = detail;
    this.connectButton.textContent = connected ? "Déconnecter" : "Connecter";
    this.connectButton.className = connected ? "pill" : "pill primary";
    this.readAllButton.disabled = this.readBankButton.disabled = !connected;
  }
}
