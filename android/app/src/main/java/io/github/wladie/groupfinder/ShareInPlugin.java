package io.github.wladie.groupfinder;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives links shared into the app from VK, Telegram, a browser, etc.
 * ("Share" → "Где разместить") and passes them to the web part as a "shared" event.
 * Events are retained until the web part starts listening, so a cold start works too.
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Mark as handled so a configuration change does not deliver it again.
        intent.setAction(Intent.ACTION_MAIN);
        if (text == null || text.trim().isEmpty()) return;
        JSObject data = new JSObject();
        data.put("text", text);
        data.put("subject", subject == null ? "" : subject);
        notifyListeners("shared", data, true);
    }
}
