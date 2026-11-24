package fr.gsystem.editor;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The app runs full screen, with the system bars hidden: Quit, in the app's menu, ends it.
 * The activity is finished and removed from the recent apps, so the next launch starts afresh.
 * openUrl shows a web page in the system's browser (linking Dropbox).
 */
@CapacitorPlugin(name = "GSystemApp")
public class GSystemAppPlugin extends Plugin {

    @PluginMethod
    public void exit(PluginCall call) {
        call.resolve();
        Activity activity = getActivity();
        activity.runOnUiThread(activity::finishAndRemoveTask);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("An https URL is needed");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No browser to open the page");
        }
    }
}
