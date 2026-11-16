package com.synq.music;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** JVM tests for the exact native file and container rules. */
public class DownloadFilesTest {

    @Test
    public void filenameStripsTraversalAndInvalidCharacters() {
        assertEquals("Artist - Song", DownloadFiles.cleanStem("../../Artist / Song"));
        assertFalse(DownloadFiles.safeFilename("../..", "mp3", "fallback").contains(".."));
        assertTrue(DownloadFiles.safeFilename("Artist - Song", "flac", "x").endsWith(".flac"));
    }

    @Test
    public void detectsRealContainersFromMagicBytes() {
        assertEquals("mp3", DownloadFiles.detectAudioFormat(
            new byte[] {'I', 'D', '3', 3, 0, 0, 0, 0, 0, 0, 0, 0}, 12));
        assertEquals("flac", DownloadFiles.detectAudioFormat(
            new byte[] {'f', 'L', 'a', 'C', 0, 0, 0, 0, 0, 0, 0, 0}, 12));
        assertEquals("wav", DownloadFiles.detectAudioFormat(
            new byte[] {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'}, 12));
        assertEquals("ogg", DownloadFiles.detectAudioFormat(
            new byte[] {'O', 'g', 'g', 'S', 0, 0, 0, 0, 0, 0, 0, 0}, 12));
        assertEquals("m4a", DownloadFiles.detectAudioFormat(
            new byte[] {0, 0, 0, 0, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, 12));
        assertNull(DownloadFiles.detectAudioFormat(
            new byte[] {'<', 'h', 't', 'm', 'l', '>', 0, 0, 0, 0, 0, 0}, 12));
    }

    @Test
    public void refusesNonHttpsAndNonAudio() {
        assertTrue(DownloadFiles.isHttps("https://example.com/song.mp3"));
        assertFalse(DownloadFiles.isHttps("http://example.com/song.mp3"));
        assertFalse(DownloadFiles.isHttps("file:///tmp/song.mp3"));
        assertTrue(DownloadFiles.isAllowedContentType("audio/mpeg"));
        assertTrue(DownloadFiles.isAllowedContentType("application/octet-stream"));
        assertFalse(DownloadFiles.isAllowedContentType("text/html"));
    }

    @Test
    public void storedNamesCannotEscapeThePrivateDirectory() {
        assertTrue(DownloadFiles.isSafeStoredName("abc123.mp3"));
        assertFalse(DownloadFiles.isSafeStoredName("../abc123.mp3"));
        assertFalse(DownloadFiles.isSafeStoredName("dir/abc123.mp3"));
        assertFalse(DownloadFiles.isSafeStoredName(".hidden"));
    }

    @Test
    public void parseContentRangeUsesTheTotalAfterSlash() {
        assertEquals(1234L, DownloadFiles.parseContentRangeTotal("bytes 0-9/1234"));
        assertEquals(-1L, DownloadFiles.parseContentRangeTotal("bytes 0-9/*"));
        assertEquals(-1L, DownloadFiles.parseContentRangeTotal("garbage"));
    }
}
