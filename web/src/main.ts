import "./styles.css";
import "./themes/oldschool.css";
import { App } from "./ui/app";
import { applyTheme } from "./ui/theme";

// The saved theme first, so that the app is never drawn in the other one.
applyTheme();
new App(document.getElementById("app")!);
