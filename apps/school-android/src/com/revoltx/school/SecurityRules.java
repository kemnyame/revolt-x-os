package com.revoltx.school;

import java.net.URI;

/** Strict origin checks also cover redirects and popup navigation. */
public final class SecurityRules {
    public static final String ORIGIN = "https://revolt-x-school-production.up.railway.app";
    public static final String HOME = ORIGIN + "/mobile";
    public static final int MAX_DOWNLOAD = 16 * 1024 * 1024;

    public static boolean isSchoolUrl(String input) {
        try {
            URI uri = new URI(input);
            return "https".equalsIgnoreCase(uri.getScheme())
                && "revolt-x-school-production.up.railway.app".equalsIgnoreCase(uri.getHost())
                && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (Exception ignored) { return false; }
    }

    public static boolean isExternalUrl(String input) {
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme();
            if ("https".equalsIgnoreCase(scheme)) return uri.getHost() != null && uri.getUserInfo() == null;
            return "tel".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme);
        } catch (Exception ignored) { return false; }
    }

    public static boolean isMobilePage(String input) {
        if (!isSchoolUrl(input)) return false;
        try {
            String path = new URI(input).getRawPath();
            return "/mobile".equals(path) || "/mobile/".equals(path)
                || "/mobile/teacher".equals(path) || "/mobile/parent".equals(path);
        } catch (Exception ignored) { return false; }
    }

    public static String safeFilename(String name) {
        String result = name == null ? "school-document" : name.replaceAll("[^A-Za-z0-9._ -]", "_");
        result = result.replaceAll("^\\.+", "").trim();
        if (result.length() > 120) result = result.substring(0, 120);
        return result.isEmpty() ? "school-document" : result;
    }
}
