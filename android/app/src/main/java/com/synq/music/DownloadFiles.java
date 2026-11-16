package com.synq.music;

import java.security.MessageDigest;
import java.util.Locale;

/**
 * Pure file/metadata rules for the native download store.
 *
 * Kept free of Android imports so the JVM unit tests can execute the exact
 * production logic. No filename is ever trusted as a path; callers combine
 * these values with an app-private directory and a hashed track key.
 */
public final class DownloadFiles {

    private DownloadFiles() {}

    /** Maximum accepted download, matching the desktop implementation. */
    public static final long MAX_FILE_BYTES = 512L * 1024L * 1024L;
    public static final long MAX_ARTWORK_BYTES = 8L * 1024L * 1024L;

    public static String cleanStem(String value) {
        if (value == null) return "";
        String cleaned = value
            .replaceAll("(?i)\\.(mp3|m4a|aac|flac|wav|ogg|opus|mp4|webm)$", "")
            .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-")
            .replaceAll("\\.{2,}", "")
            .replaceAll("\\s+", " ")
            .replaceAll("^[-. ]+|[-. ]+$", "")
            .trim();
        if (cleaned.length() > 140) cleaned = cleaned.substring(0, 140);
        return cleaned.replaceAll("[. ]+$", "");
    }

    public static String safeFilename(String stem, String format, String fallback) {
        String base = cleanStem(stem);
        if (base.isEmpty()) base = cleanStem(fallback);
        if (base.isEmpty()) base = "track";
        return base + "." + format;
    }

    public static boolean isAllowedContentType(String contentType) {
        if (contentType == null) return false;
        String type = contentType.split(";")[0].trim().toLowerCase(Locale.ROOT);
        return type.startsWith("audio/")
            || type.equals("application/ogg")
            || type.equals("application/octet-stream");
    }

    public static boolean isHttps(String value) {
        if (value == null || value.isEmpty() || value.length() > 4096) return false;
        try {
            java.net.URL url = new java.net.URL(value);
            return "https".equalsIgnoreCase(url.getProtocol())
                && url.getUserInfo() == null;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Inspect the container from its magic bytes, never from its suffix. */
    public static String detectAudioFormat(byte[] bytes, int length) {
        if (bytes == null || length < 12) return null;
        int b0 = bytes[0] & 0xff;
        int b1 = bytes[1] & 0xff;
        String first4 = ascii(bytes, 0, 4);

        if (bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33) {
            return "mp3";
        }
        if (b0 == 0xff && (b1 & 0xe0) == 0xe0) {
            if ((b1 & 0xf6) == 0xf0 || (b1 & 0xf6) == 0xf8) return "aac";
            if ((b1 & 0x06) == 0x02) return "mp3";
        }
        if ("ftyp".equals(ascii(bytes, 4, 8)) || "styp".equals(ascii(bytes, 4, 8))) {
            return "m4a";
        }
        if ("fLaC".equals(first4)) return "flac";
        if ("RIFF".equals(first4) && "WAVE".equals(ascii(bytes, 8, 12))) {
            return "wav";
        }
        if ("OggS".equals(first4)) return "ogg";
        return null;
    }

    public static String detectImageExtension(byte[] bytes, int length) {
        if (bytes == null || length < 4) return null;
        int b0 = bytes[0] & 0xff;
        int b1 = bytes[1] & 0xff;
        int b2 = bytes[2] & 0xff;
        if (b0 == 0xff && b1 == 0xd8 && b2 == 0xff) return "jpg";
        if (
            length >= 8
                && b0 == 0x89
                && bytes[1] == 0x50
                && bytes[2] == 0x4e
                && bytes[3] == 0x47
        ) {
            return "png";
        }
        return null;
    }

    /** Stored names are generated internally; the index is still validated so
     * a tampered or corrupt index can never point outside the download
     * directory. */
    public static boolean isSafeStoredName(String name) {
        return name != null
            && !name.isEmpty()
            && name.length() <= 200
            && name.matches("^[A-Za-z0-9._-]+$")
            && !name.contains("..")
            && !name.startsWith(".");
    }

    public static String hashTrackId(String trackId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(trackId.getBytes("UTF-8"));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                out.append(String.format(Locale.ROOT, "%02x", hash[i]));
            }
            return out.toString();
        } catch (Exception impossible) {
            // SHA-256 is mandatory on every Android release. A deterministic
            // fallback still keeps the filename app-private, never a user path.
            return Integer.toHexString(trackId.hashCode());
        }
    }

    public static long parseContentRangeTotal(String header) {
        if (header == null) return -1;
        int slash = header.lastIndexOf('/');
        if (slash < 0 || slash == header.length() - 1) return -1;
        String total = header.substring(slash + 1).trim();
        if ("*".equals(total)) return -1;
        try {
            long value = Long.parseLong(total);
            return value >= 0 ? value : -1;
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    public static String mimeForFormat(String format) {
        if ("mp3".equals(format)) return "audio/mpeg";
        if ("m4a".equals(format)) return "audio/mp4";
        if ("aac".equals(format)) return "audio/aac";
        if ("flac".equals(format)) return "audio/flac";
        if ("wav".equals(format)) return "audio/wav";
        if ("ogg".equals(format)) return "audio/ogg";
        return "application/octet-stream";
    }

    private static String ascii(byte[] bytes, int start, int end) {
        StringBuilder out = new StringBuilder();
        for (int i = start; i < end && i < bytes.length; i++) {
            out.append((char) (bytes[i] & 0xff));
        }
        return out.toString();
    }
}
