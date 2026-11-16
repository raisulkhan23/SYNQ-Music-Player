package com.synq.music;

import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native, persistent offline downloads for the Android application.
 *
 * Files are written to app-private storage (`getFilesDir()/downloads`), which
 * survives process death, device restarts and app updates without any broad
 * storage permission. The plugin owns the queue, so navigating pages or closing
 * the WebView does not cancel or forget a transfer.
 *
 * The renderer can only pass a provider-granted HTTPS URL and metadata. It
 * cannot supply a path, directory, command, or arbitrary extension that becomes
 * a filesystem location: every stored filename is hashed from the validated
 * track id, and the final extension comes from the downloaded bytes.
 */
@CapacitorPlugin(name = "SynqDownloads")
public class SynqDownloadsPlugin extends Plugin {

    private static final String TAG = "SYNQDownloads";
    private static final int MAX_ACTIVE = 2;
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 45_000;
    private static final int BUFFER_BYTES = 64 * 1024;

    private final ExecutorService pool = Executors.newFixedThreadPool(MAX_ACTIVE);
    private final Map<String, JSONObject> records = new LinkedHashMap<>();
    private final Map<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private final AtomicInteger running = new AtomicInteger(0);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private File directory;
    private boolean initialized;
    private long lastNotifyAt;

    @Override
    public void load() {
        ensureInitialized();
    }

    private synchronized void ensureInitialized() {
        if (initialized) return;
        directory = new File(getContext().getFilesDir(), "downloads");
        if (!directory.exists() && !directory.mkdirs()) {
            Log.e(TAG, "Could not create the private downloads directory");
        }
        loadIndex();
        initialized = true;
        schedulePump();
    }

    private synchronized File indexPath() {
        return new File(directory, "index.json");
    }

    private synchronized void loadIndex() {
        File index = indexPath();
        if (!index.isFile()) return;
        try {
            String raw = readText(index);
            JSONObject root = new JSONObject(raw);
            JSONArray stored = root.optJSONArray("records");
            if (stored == null) return;
            boolean changed = false;
            for (int i = 0; i < stored.length(); i++) {
                JSONObject record = stored.optJSONObject(i);
                if (record == null) continue;
                String id = record.optString("id", "");
                String trackId = record.optString("trackId", "");
                if (id.isEmpty() || trackId.isEmpty()) continue;
                String fileName = record.optString("fileName", "");
                String partName = record.optString("partName", "");
                String artworkName = record.optString("artworkName", "");
                if (!fileName.isEmpty() && !DownloadFiles.isSafeStoredName(fileName)) continue;
                if (!partName.isEmpty() && !DownloadFiles.isSafeStoredName(partName)) continue;
                if (!artworkName.isEmpty() && !DownloadFiles.isSafeStoredName(artworkName)) continue;
                String status = record.optString("status", "");
                if ("downloading".equals(status) || "validating".equals(status)) {
                    record.put("status", "failed");
                    record.put("error", "Download was interrupted when SYNQ closed.");
                    record.put("speed", 0);
                    changed = true;
                }
                if ("completed".equals(status)) {
                    if (!DownloadFiles.isSafeStoredName(fileName)) continue;
                    File file = new File(directory, fileName);
                    if (!file.isFile() || file.length() <= 0) {
                        record.put("status", "failed");
                        record.put("error", "The downloaded file is missing or corrupt.");
                        changed = true;
                    } else {
                        record.put("fileSize", file.length());
                    }
                }
                records.put(id, record);
            }
            if (changed) saveIndex();
        } catch (Exception error) {
            Log.w(TAG, "Download index could not be read", error);
            records.clear();
        }
    }

    private String readText(File file) throws Exception {
        try (
            FileInputStream input = new FileInputStream(file);
            ByteArrayOutputStream output = new ByteArrayOutputStream()
        ) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            return output.toString("UTF-8");
        }
    }

    private synchronized void saveIndex() {
        try {
            JSONObject root = new JSONObject();
            root.put("version", 1);
            JSONArray rows = new JSONArray();
            for (JSONObject record : records.values()) rows.put(record);
            root.put("records", rows);
            File temp = new File(directory, "index.json.tmp");
            try (FileOutputStream output = new FileOutputStream(temp)) {
                output.write(root.toString().getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            File target = indexPath();
            if (target.exists() && !target.delete()) {
                throw new IllegalStateException("Could not replace the download index");
            }
            if (!temp.renameTo(target)) {
                throw new IllegalStateException("Could not commit the download index");
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not persist the download index", error);
        }
    }

    private void notifyChanged() {
        long now = System.currentTimeMillis();
        if (now - lastNotifyAt < 120) return;
        lastNotifyAt = now;
        mainHandler.post(() -> {
            try {
                JSObject event = new JSObject();
                event.put("count", records.size());
                notifyListeners("downloadsChanged", event);
            } catch (Exception error) {
                Log.w(TAG, "Download state listener failed", error);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        ensureInitialized();
        JSObject request = call.getObject("request");
        if (request == null) {
            call.reject("A download request is required");
            return;
        }
        try {
            JSONObject validated = validate(request);
            String trackId = validated.getString("trackId");
            synchronized (this) {
                for (JSONObject existing : records.values()) {
                    if (trackId.equals(existing.optString("trackId"))) {
                        call.resolve(snapshot(existing));
                        return;
                    }
                }
                String id = UUID.randomUUID().toString();
                String hash = DownloadFiles.hashTrackId(trackId);
                JSONObject record = new JSONObject();
                record.put("id", id);
                record.put("trackId", trackId);
                record.put("filename", DownloadFiles.safeFilename(
                    validated.optString("filename"),
                    "mp3",
                    "track-" + id
                ));
                record.put("status", "queued");
                record.put("bytes", 0);
                record.put("totalBytes", JSONObject.NULL);
                record.put("speed", 0);
                record.put("hash", hash);
                record.put("partName", hash + ".part");
                record.put("request", validated);
                record.put("metadata", metadata(validated));
                records.put(id, record);
                saveIndex();
                call.resolve(snapshot(record));
            }
            notifyChanged();
            schedulePump();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Invalid download request" : error.getMessage());
        }
    }

    private JSONObject validate(JSObject request) throws Exception {
        JSONObject out = new JSONObject(request.toString());
        String trackId = out.optString("trackId", "");
        if (!trackId.matches("^[A-Za-z0-9:_-]{1,200}$")) {
            throw new IllegalArgumentException("Invalid track id");
        }
        String url = out.optString("downloadUrl", "");
        if (!DownloadFiles.isHttps(url)) {
            throw new IllegalArgumentException("Download URL must be HTTPS");
        }
        String provider = out.optString("provider", "");
        if (!"jamendo".equals(provider) && !"soundcloud".equals(provider)) {
            throw new IllegalArgumentException("Unsupported download provider");
        }
        String contentType = out.optString("contentType", "");
        if (!DownloadFiles.isAllowedContentType(contentType)) {
            throw new IllegalArgumentException("The provider did not grant an audio file");
        }
        String filename = out.optString("filename", "");
        if (filename.isEmpty() || filename.length() > 260) {
            throw new IllegalArgumentException("Invalid filename");
        }
        String title = out.optString("title", "");
        String artist = out.optString("artist", "");
        if (title.length() > 300 || artist.length() > 300) {
            throw new IllegalArgumentException("Invalid track metadata");
        }
        String album = out.optString("album", "");
        if (album.length() > 300) {
            throw new IllegalArgumentException("Invalid album");
        }
        String licenseUrl = out.optString("licenseUrl", "");
        if (!DownloadFiles.isHttps(licenseUrl)) {
            throw new IllegalArgumentException("Invalid license URL");
        }
        String attribution = out.optString("attribution", "");
        if (attribution.length() > 500) {
            throw new IllegalArgumentException("Invalid attribution");
        }
        String artworkUrl = out.optString("artworkUrl", "");
        if (!artworkUrl.isEmpty() && !DownloadFiles.isHttps(artworkUrl)) {
            throw new IllegalArgumentException("Invalid artwork URL");
        }
        double duration = out.optDouble("durationMs", 0);
        if (duration < 0 || duration > 86_400_000d) {
            throw new IllegalArgumentException("Invalid duration");
        }
        return out;
    }

    private JSONObject metadata(JSONObject request) throws Exception {
        JSONObject meta = new JSONObject();
        meta.put("title", request.optString("title", "").trim());
        meta.put("artist", request.optString("artist", "").trim());
        String album = request.optString("album", "").trim();
        if (!album.isEmpty()) meta.put("album", album);
        String artwork = request.optString("artworkUrl", "");
        if (!artwork.isEmpty()) meta.put("artworkUrl", artwork);
        if (request.has("durationMs")) meta.put("durationMs", request.optLong("durationMs"));
        meta.put("licenseUrl", request.optString("licenseUrl", ""));
        meta.put("attribution", request.optString("attribution", ""));
        meta.put("provider", request.optString("provider", ""));
        return meta;
    }

    @PluginMethod
    public void list(PluginCall call) {
        ensureInitialized();
        try {
            List<JSONObject> rows;
            synchronized (this) {
                rows = new ArrayList<>(records.values());
            }
            rows.sort((a, b) -> {
                int rank = Integer.compare(rank(a.optString("status")), rank(b.optString("status")));
                if (rank != 0) return rank;
                return Long.compare(b.optLong("downloadedAt", 0), a.optLong("downloadedAt", 0));
            });
            JSArrayResult result = new JSArrayResult();
            List<JSObject> snapshots = new ArrayList<>();
            for (JSONObject row : rows) snapshots.add(snapshot(row));
            call.resolve(result.with(snapshots));
        } catch (Exception error) {
            call.reject("Could not read downloads");
        }
    }

    private static int rank(String status) {
        if ("downloading".equals(status)) return 0;
        if ("validating".equals(status)) return 1;
        if ("queued".equals(status)) return 2;
        if ("failed".equals(status)) return 3;
        if ("cancelled".equals(status)) return 4;
        return 5;
    }

    private JSObject snapshot(JSONObject record) {
        JSObject out = new JSObject();
        try {
            out.put("id", record.optString("id"));
            out.put("trackId", record.optString("trackId"));
            out.put("filename", record.optString("filename"));
            out.put("status", record.optString("status"));
            long bytes = record.optLong("bytes", 0);
            long total = record.has("totalBytes") && !record.isNull("totalBytes")
                ? record.optLong("totalBytes", -1)
                : -1;
            double speed = record.optDouble("speed", 0);
            out.put("bytes", bytes);
            if (total > 0) out.put("totalBytes", total);
            else out.put("totalBytes", JSONObject.NULL);
            out.put("progress", "completed".equals(record.optString("status"))
                ? 100
                : (total > 0 ? Math.min(100, Math.max(0, (bytes * 100.0) / total)) : 0));
            out.put("speed", speed);
            if (speed > 0 && total > bytes) {
                out.put("etaMs", Math.round(((total - bytes) / speed) * 1000d));
            } else {
                out.put("etaMs", JSONObject.NULL);
            }
            if (!record.optString("error", "").isEmpty()) {
                out.put("error", record.optString("error"));
            }
            if (!record.optString("format", "").isEmpty()) {
                out.put("format", record.optString("format"));
            }
            if (record.optLong("fileSize", 0) > 0) {
                out.put("fileSize", record.optLong("fileSize"));
            }
            if (record.optLong("downloadedAt", 0) > 0) {
                out.put("downloadedAt", record.optLong("downloadedAt"));
            }
            out.put("metadata", record.optJSONObject("metadata"));
        } catch (Exception ignored) {
            // A snapshot is built from values this plugin wrote.
        }
        return out;
    }

    private static final class JSArrayResult {
        JSObject with(List<JSObject> rows) throws Exception {
            JSObject out = new JSObject();
            JSONArray array = new JSONArray();
            for (JSObject row : rows) array.put(row);
            out.put("records", array);
            return out;
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        ensureInitialized();
        String id = call.getString("id");
        JSONObject record = find(id);
        if (record == null) {
            call.resolve();
            return;
        }
        try {
            synchronized (this) {
                if ("completed".equals(record.optString("status"))) {
                    call.resolve();
                    return;
                }
                record.put("status", "cancelled");
                record.put("error", "");
                record.put("speed", 0);
                saveIndex();
            }
            HttpURLConnection connection = connections.get(id);
            if (connection != null) connection.disconnect();
            String partName = record.optString("partName");
            File part = DownloadFiles.isSafeStoredName(partName)
                ? new File(directory, partName)
                : null;
            if (part != null && part.exists()) part.delete();
            notifyChanged();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not cancel the download");
        }
    }

    @PluginMethod
    public void retry(PluginCall call) {
        ensureInitialized();
        JSONObject record = find(call.getString("id"));
        if (record == null) {
            call.reject("Download not found");
            return;
        }
        try {
            String status = record.optString("status");
            if (!"failed".equals(status) && !"cancelled".equals(status)) {
                call.resolve();
                return;
            }
            synchronized (this) {
                record.put("status", "queued");
                record.put("error", "");
                record.put("speed", 0);
                saveIndex();
            }
            notifyChanged();
            schedulePump();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not retry the download");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        ensureInitialized();
        String id = call.getString("id");
        JSONObject record = find(id);
        if (record == null) {
            JSObject out = new JSObject();
            out.put("removed", false);
            call.resolve(out);
            return;
        }
        synchronized (this) {
            record.optString("status");
            try {
                record.put("status", "cancelled");
            } catch (Exception ignored) {}
        }
        HttpURLConnection connection = connections.get(id);
        if (connection != null) connection.disconnect();
        String fileName = record.optString("fileName");
        String partName = record.optString("partName");
        String artworkName = record.optString("artworkName");
        File file = DownloadFiles.isSafeStoredName(fileName) ? new File(directory, fileName) : null;
        File part = DownloadFiles.isSafeStoredName(partName) ? new File(directory, partName) : null;
        File cover = DownloadFiles.isSafeStoredName(artworkName) ? new File(directory, artworkName) : null;
        if (file != null && file.exists()) file.delete();
        if (part != null && part.exists()) part.delete();
        if (cover != null && cover.exists()) cover.delete();
        synchronized (this) {
            records.remove(id);
            saveIndex();
        }
        notifyChanged();
        JSObject out = new JSObject();
        out.put("removed", true);
        call.resolve(out);
    }

    @PluginMethod
    public void getPlaybackPath(PluginCall call) {
        ensureInitialized();
        String trackId = call.getString("trackId");
        JSONObject record = completedByTrack(trackId);
        JSObject out = new JSObject();
        File file = record == null ? null : new File(directory, record.optString("fileName"));
        if (file != null && file.isFile() && file.length() > 0) {
            out.put("path", file.toURI().toString());
        } else {
            out.put("path", JSONObject.NULL);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void getArtworkPath(PluginCall call) {
        ensureInitialized();
        String trackId = call.getString("trackId");
        JSONObject record = completedByTrack(trackId);
        JSObject out = new JSObject();
        String artworkName = record == null ? "" : record.optString("artworkName");
        File cover = DownloadFiles.isSafeStoredName(artworkName)
            ? new File(directory, artworkName)
            : null;
        if (cover != null && cover.isFile() && cover.length() > 0) {
            out.put("path", cover.toURI().toString());
        } else {
            out.put("path", JSONObject.NULL);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void getStorage(PluginCall call) {
        ensureInitialized();
        long used = 0;
        int count = 0;
        synchronized (this) {
            for (JSONObject record : records.values()) {
                if (
                    "completed".equals(record.optString("status"))
                        && DownloadFiles.isSafeStoredName(record.optString("fileName"))
                ) {
                    used += record.optLong("fileSize", 0);
                    count += 1;
                } else {
                    used += record.optLong("bytes", 0);
                }
            }
        }
        long available = -1;
        try {
            StatFs stat = new StatFs(directory.getAbsolutePath());
            available = stat.getAvailableBytes();
        } catch (Exception ignored) {}
        JSObject out = new JSObject();
        out.put("usedBytes", used);
        out.put("fileCount", count);
        out.put("availableBytes", available >= 0 ? available : JSONObject.NULL);
        out.put("directory", "app-private/downloads");
        call.resolve(out);
    }

    private JSONObject find(String id) {
        if (id == null) return null;
        synchronized (this) {
            return records.get(id);
        }
    }

    private JSONObject completedByTrack(String trackId) {
        if (trackId == null) return null;
        synchronized (this) {
            for (JSONObject record : records.values()) {
                if (
                    trackId.equals(record.optString("trackId"))
                        && "completed".equals(record.optString("status"))
                        && DownloadFiles.isSafeStoredName(record.optString("fileName"))
                ) {
                    return record;
                }
            }
        }
        return null;
    }

    private void schedulePump() {
        while (running.get() < MAX_ACTIVE) {
            final JSONObject next;
            synchronized (this) {
                JSONObject found = null;
                for (JSONObject record : records.values()) {
                    if ("queued".equals(record.optString("status"))) {
                        found = record;
                        break;
                    }
                }
                if (found == null) return;
                try {
                    found.put("status", "downloading");
                } catch (Exception error) {
                    return;
                }
                next = found;
            }
            running.incrementAndGet();
            pool.execute(() -> {
                try {
                    runDownload(next);
                } catch (Exception error) {
                    Log.e(TAG, "Download worker failed", error);
                } finally {
                    running.decrementAndGet();
                    schedulePump();
                }
            });
        }
    }

    private void runDownload(JSONObject record) {
        String id = record.optString("id");
        HttpURLConnection connection = null;
        FileOutputStream fileOut = null;
        try {
            if ("cancelled".equals(record.optString("status"))) return;
            JSONObject request = record.getJSONObject("request");
            File part = new File(directory, record.optString("partName"));
            long existing = part.isFile() ? part.length() : 0;

            URL current = new URL(request.getString("downloadUrl"));
            for (int redirects = 0; redirects <= 5; redirects++) {
                if (!DownloadFiles.isHttps(current.toString())) {
                    throw new Exception("The download redirected to a non-HTTPS URL.");
                }
                connection = (HttpURLConnection) current.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "audio/*, application/octet-stream;q=0.8");
                connection.setRequestProperty("User-Agent", "SYNQ/1.0 (Android offline downloads)");
                if (existing > 0) connection.setRequestProperty("Range", "bytes=" + existing + "-");
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    connection = null;
                    if (location == null || redirects == 5) {
                        throw new Exception("The audio source redirected too many times.");
                    }
                    current = new URL(current, location);
                    continue;
                }
                if (code != 200 && code != 206) {
                    throw new Exception("The source returned HTTP " + code + ".");
                }
                break;
            }
            if (connection == null) throw new Exception("Could not reach the audio source.");
            connections.put(id, connection);

            String contentType = connection.getContentType();
            if (!DownloadFiles.isAllowedContentType(contentType)) {
                throw new Exception("The source did not return an audio file.");
            }
            boolean resume = existing > 0 && connection.getResponseCode() == 206;
            if (existing > 0 && !resume) existing = 0;
            long total = DownloadFiles.parseContentRangeTotal(connection.getHeaderField("Content-Range"));
            long contentLength = connection.getContentLengthLong();
            if (total <= 0 && contentLength > 0) total = existing + contentLength;
            if (total > DownloadFiles.MAX_FILE_BYTES) {
                throw new Exception("The audio file exceeds SYNQ's 512 MB download limit.");
            }

            synchronized (this) {
                record.put("status", "downloading");
                record.put("totalBytes", total > 0 ? total : JSONObject.NULL);
                record.put("bytes", existing);
                record.put("speed", 0);
                record.put("error", "");
                saveIndex();
            }
            notifyChanged();

            fileOut = new FileOutputStream(part, resume);
            InputStream input = new BufferedInputStream(connection.getInputStream());
            byte[] buffer = new byte[BUFFER_BYTES];
            byte[] head = new byte[16];
            int headLength = 0;
            long bytes = existing;
            long lastTick = System.currentTimeMillis();
            long lastBytes = existing;
            int read;
            while ((read = input.read(buffer)) != -1) {
                if ("cancelled".equals(record.optString("status"))) {
                    throw new InterruptedException("cancelled");
                }
                if (headLength < 16) {
                    int copy = Math.min(read, 16 - headLength);
                    System.arraycopy(buffer, 0, head, headLength, copy);
                    headLength += copy;
                }
                if (bytes + read > DownloadFiles.MAX_FILE_BYTES) {
                    throw new Exception("The audio file exceeds SYNQ's 512 MB download limit.");
                }
                fileOut.write(buffer, 0, read);
                bytes += read;
                long now = System.currentTimeMillis();
                long elapsed = now - lastTick;
                if (elapsed >= 350) {
                    double sample = (bytes - lastBytes) * 1000d / elapsed;
                    double previous = record.optDouble("speed", 0);
                    synchronized (this) {
                        record.put("bytes", bytes);
                        record.put("speed", previous == 0 ? sample : previous * 0.7 + sample * 0.3);
                    }
                    lastTick = now;
                    lastBytes = bytes;
                    notifyChanged();
                }
            }
            fileOut.flush();
            fileOut.getFD().sync();
            fileOut.close();
            fileOut = null;
            input.close();

            if (total > 0 && bytes != total) {
                throw new Exception("Incomplete download: " + bytes + " of " + total + " bytes received.");
            }
            if (bytes <= 0) throw new Exception("The source returned an empty audio file.");
            if (headLength < 12) {
                try (FileInputStream probe = new FileInputStream(part)) {
                    headLength = Math.max(0, probe.read(head));
                }
            }
            synchronized (this) {
                record.put("status", "validating");
                record.put("speed", 0);
                saveIndex();
            }
            notifyChanged();

            String format = DownloadFiles.detectAudioFormat(head, headLength);
            if (format == null) {
                part.delete();
                throw new Exception("The downloaded file is not a supported audio container.");
            }
            String fileName = record.optString("hash") + "." + format;
            File finalFile = new File(directory, fileName);
            if (finalFile.exists() && !finalFile.delete()) {
                throw new Exception("Could not replace the previous copy.");
            }
            if (!part.renameTo(finalFile)) {
                throw new Exception("Could not move the completed download into storage.");
            }
            synchronized (this) {
                record.put("fileSize", finalFile.length());
                record.put("format", format);
                record.put("fileName", fileName);
                record.put("filename", DownloadFiles.safeFilename(
                    record.optString("filename"),
                    format,
                    "track-" + id
                ));
                record.put("downloadedAt", System.currentTimeMillis());
                record.put("bytes", finalFile.length());
                record.put("totalBytes", finalFile.length());
                record.put("speed", 0);
                record.put("status", "completed");
                record.put("error", "");
                saveIndex();
            }
            downloadArtwork(record, request.optString("artworkUrl", ""));
            notifyChanged();
        } catch (Exception error) {
            boolean cancelled = "cancelled".equals(record.optString("status"));
            try {
                synchronized (this) {
                    if (cancelled) {
                        record.put("status", "cancelled");
                        record.put("error", "");
                    } else {
                        record.put("status", "failed");
                        record.put("error", error.getMessage() == null
                            ? "The download failed."
                            : error.getMessage());
                    }
                    record.put("speed", 0);
                    saveIndex();
                }
                if (cancelled) {
                    new File(directory, record.optString("partName")).delete();
                }
            } catch (Exception ignored) {}
            notifyChanged();
        } finally {
            connections.remove(id);
            try {
                if (fileOut != null) fileOut.close();
            } catch (Exception ignored) {}
            if (connection != null) connection.disconnect();
        }
    }

    private void downloadArtwork(JSONObject record, String artworkUrl) {
        if (artworkUrl == null || artworkUrl.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            URL url = new URL(artworkUrl);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return;
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "image/jpeg, image/png");
            if (connection.getResponseCode() != 200) return;
            String type = connection.getContentType();
            if (type == null) return;
            type = type.split(";")[0].trim().toLowerCase(Locale.ROOT);
            if (!"image/jpeg".equals(type) && !"image/png".equals(type)) return;
            long length = connection.getContentLengthLong();
            if (length > DownloadFiles.MAX_ARTWORK_BYTES) return;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            InputStream input = new BufferedInputStream(connection.getInputStream());
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > DownloadFiles.MAX_ARTWORK_BYTES) {
                    input.close();
                    return;
                }
                bytes.write(buffer, 0, read);
            }
            input.close();
            byte[] image = bytes.toByteArray();
            String extension = DownloadFiles.detectImageExtension(image, image.length);
            if (extension == null) return;
            String name = record.optString("hash") + ".cover." + extension;
            File target = new File(directory, name);
            try (FileOutputStream output = new FileOutputStream(target)) {
                output.write(image);
                output.getFD().sync();
            }
            synchronized (this) {
                record.put("artworkName", name);
                saveIndex();
            }
        } catch (Exception ignored) {
            // The audio remains complete and playable; artwork is optional.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
