import "./styles.css";
import { App } from "./ui/app";
import { applySkin } from "./ui/skin";

// Before the first render, so the chosen finish shows at once.
applySkin();

new App(document.getElementById("app")!);
