// Desktop shell (Electron): serves the built app from dist/ and opens it in a window with
// Web MIDI, so a computer needs neither Node, nor Chrome, nor a local server.
const { app, BrowserWindow, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..", "dist");
// Web MIDI needs a secure context; a privileged scheme also keeps one stable origin for localStorage.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIDI_PERMISSIONS = new Set(["midi", "midiSysex"]);

function serveDist() {
  protocol.handle("app", (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: "#26272a",
    autoHideMenuBar: true,
    // Full screen everywhere; on macOS in its own Space, left with the green button or Ctrl+Cmd+F.
    fullscreen: true,
    fullscreenable: true,
    title: "G-System Editor",
  });
  // Links leave the app for the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL("app://gsystem/index.html");
}

app.whenReady().then(() => {
  serveDist();
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(MIDI_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => MIDI_PERMISSIONS.has(permission));
  createWindow();
});

app.on("window-all-closed", () => app.quit());
