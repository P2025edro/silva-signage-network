package ie.silvasolutions.signage.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Opens the player when the TV finishes booting (and after the app is updated). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent launch = new Intent(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(launch);
        } catch (RuntimeException ignored) {
            // Blocked by the system (e.g. permission not granted): the app stays one click away.
        }
    }
}
