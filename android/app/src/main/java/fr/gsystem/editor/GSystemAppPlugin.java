package fr.gsystem.editor;

import android.app.Activity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The app runs full screen, with the system bars hidden: Quit, in the app's menu, ends it.
 * The activity is finished and removed from the recent apps, so the next launch starts afresh.
 */
@CapacitorPlugin(name = "GSystemApp")
public class GSystemAppPlugin extends Plugin {

    @PluginMethod
    public void exit(PluginCall call) {
        call.resolve();
        Activity activity = getActivity();
        activity.runOnUiThread(activity::finishAndRemoveTask);
    }
}
