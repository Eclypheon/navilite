package app.navilite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Keeps playback alive while the app is in the background.
 *
 * It deliberately does nothing but hold a foreground slot: the audio itself is ExoPlayer
 * inside @capgo/capacitor-native-audio, and the media controls are that plugin's own
 * Now Playing notification. This service exists because "a music player that stops when
 * you lock the screen" is not a music player, and Android only lets an app keep running
 * in the background behind a foreground service (mediaPlayback type).
 *
 * The notification is intentionally quiet and secondary: low importance, silent, no
 * media style, so the plugin's media notification stays the one the user interacts with.
 */
public class BackgroundAudioService extends Service {

    private static final String CHANNEL_ID = "navilite-background-playback";
    private static final int NOTIFICATION_ID = 4711;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.background_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.background_channel_description));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.background_notification_title))
                .setContentText(getString(R.string.background_notification_text))
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pending)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setSilent(true)
                .setOngoing(true)
                .build();
    }
}
