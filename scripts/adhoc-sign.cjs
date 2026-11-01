// electron-builder afterPack hook: ad-hoc signs the macOS app.
// Built from Linux, the bundle keeps Electron's original signature, which no longer matches once
// electron-builder has renamed it and changed Info.plist and the resources. On Apple Silicon
// macOS then calls the app "damaged". An ad-hoc signature (no Apple certificate) seals the
// bundle again; macOS still asks for confirmation on first launch, since the app is not notarized.
// Needs rcodesign (https://github.com/indygreg/apple-platform-rs) in PATH, or its path in RCODESIGN.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const rcodesign = process.env.RCODESIGN || "rcodesign";
  try {
    execFileSync(rcodesign, ["sign", app], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `ad-hoc signing of ${app} failed (${error.message}). Install rcodesign or set RCODESIGN; ` +
        "without a valid signature macOS on Apple Silicon reports the app as damaged.",
    );
  }
};
