package com.revoltx.school;

import java.net.URI;

/** Strict origin checks also cover redirects and popup navigation. */
public final class SecurityRules {
    public static final String ORIGIN = "https://revolt-x-school.onrender.com";
    public static final String HOME = ORIGIN + "/mobile";
    public static final int MAX_DOWNLOAD = 16 * 1024 * 1024;

    public static boolean isSchoolUrl(String input) {
        try {
            URI uri = new URI(input);
            return "https".equalsIgnoreCase(uri.getScheme())
                && "revolt-x-school.onrender.com".equalsIgnoreCase(uri.getHost())
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

    /** An invitation carries public school context only, never a session or password. */
    public static String mobileLaunchUrl(String input) {
        if (!isSchoolUrl(input)) return null;
        try {
            URI uri = new URI(input);
            String path = uri.getPath(), school = null;
            String query = uri.getRawQuery();
            if (query != null) for (String pair : query.split("&")) {
                String[] parts = pair.split("=", 2);
                if ("school".equals(java.net.URLDecoder.decode(parts[0], "UTF-8"))) {
                    if (school != null || parts.length != 2) return null;
                    school = java.net.URLDecoder.decode(parts[1], "UTF-8");
                }
            }
            if (path.matches("/s/[A-Za-z0-9-]+/(login|admin-login)")) {
                String named = path.split("/")[2];
                if (school != null && !school.equalsIgnoreCase(named)) return null;
                school = named; path = "/mobile";
            }
            if ("/mobile/setup".equals(path) || "/mobile/".equals(path)) path = "/mobile";
            if (!("/mobile".equals(path) || "/mobile/teacher".equals(path) || "/mobile/parent".equals(path))) return null;
            if (school == null || !school.matches("[A-Za-z0-9][A-Za-z0-9-]{0,119}")) return null;
            return ORIGIN + path + "?school=" + school.toLowerCase(java.util.Locale.ROOT);
        } catch (Exception ignored) { return null; }
    }

    public static String mobileHomeUrl(String input) {
        String launch = mobileLaunchUrl(input);
        return launch == null ? HOME : HOME + launch.substring(launch.indexOf('?'));
    }

    public static String safeFilename(String name) {
        String result = name == null ? "school-document" : name.replaceAll("[^A-Za-z0-9._ -]", "_");
        result = result.replaceAll("^\\.+", "").trim();
        if (result.length() > 120) result = result.substring(0, 120);
        return result.isEmpty() ? "school-document" : result;
    }
}
