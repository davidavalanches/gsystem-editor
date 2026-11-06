package fr.gsystem.editor;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/**
 * Saving a file where the user chooses, through Android's "Save as" screen (Storage Access
 * Framework). It needs no storage permission, unlike writing into the shared Documents folder,
 * which Android 10 and older refuse without one.
 */
@CapacitorPlugin(name = "GSystemFiles")
public class GSystemFilesPlugin extends Plugin {

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || data == null) {
            call.reject("name and data are required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saved");
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent intent = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || intent == null || intent.getData() == null) {
            JSObject out = new JSObject();
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }
        Uri uri = intent.getData();
        try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (stream == null) throw new java.io.IOException("cannot open the chosen file");
            stream.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
        } catch (Exception e) {
            call.reject("Cannot write the file: " + e.getMessage(), e);
            return;
        }
        JSObject out = new JSObject();
        out.put("cancelled", false);
        out.put("name", displayName(uri, call.getString("name")));
        call.resolve(out);
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // The name given is close enough.
        }
        return fallback;
    }
}
