package io.arkhen.p2p.bridge;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;

/** Keeps only observed numeric SDK fields; callback text is never retained. */
final class BridgeDiagnostics {
    private final Map<String, Integer> numbers = new LinkedHashMap<>();
    private final Map<String, Map<String, Object>> shapes = new LinkedHashMap<>();
    private String errorClass = "";

    synchronized void reset() { numbers.clear(); shapes.clear(); errorClass = ""; }
    synchronized void clearPlayback() { numbers.remove("errno"); numbers.remove("peers"); errorClass = ""; }
    synchronized void record(String event, Map<String, Object> values) {
        String[] fields = "inited".equals(event) ? new String[]{"auth", "tvcore", "extra_errno"}
            : "stop".equals(event) ? new String[]{"errno"}
            : "start".equals(event) ? new String[]{"peers"} : new String[0];
        for (String field : fields) {
            Integer value = integer(values.get(field));
            if (value == null) numbers.remove(field); else numbers.put(field, value);
        }
    }
    synchronized String initializationState() {
        Integer auth = numbers.get("auth"), core = numbers.get("tvcore");
        if (auth != null && auth < -1) return "authentication_failed";
        // The upstream TVBus demo recognizes exactly zero as core success.
        if (core != null && core != 0) return "initialization_failed";
        if (auth == null || core == null || auth < 0) return "initialization_unknown";
        return "initialized";
    }
    synchronized void initializationReturn(int code) { numbers.put("initReturn", code); }
    synchronized void loopReturn(int code) { numbers.put("runReturn", code); }
    synchronized String playbackStoppedState() {
        Integer code = numbers.get("errno");
        return code != null && code < 0 ? "playback_failed" : "stopped";
    }
    synchronized void failure(Throwable error) { errorClass = error.getClass().getName(); }
    synchronized void shape(String event, String format, Map<String, String> fieldTypes, Object scalar) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("format", format);
        result.put("fields", new LinkedHashMap<>(fieldTypes));
        Integer number = integer(scalar);
        if (number != null) result.put("scalarNumber", number);
        shapes.put(event, result);
    }
    synchronized Map<String, Object> snapshot() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.putAll(numbers);
        result.put("callbackShapes", new LinkedHashMap<>(shapes));
        if (!errorClass.isEmpty()) result.put("errorClass", errorClass);
        return result;
    }
    private static Integer integer(Object value) {
        if (value instanceof String && ((String)value).matches("-?[0-9]{1,10}")) {
            try { return Integer.valueOf((String)value); } catch (NumberFormatException ignored) { return null; }
        }
        if (!(value instanceof Number)) return null;
        double number = ((Number)value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number < Integer.MIN_VALUE
            || number > Integer.MAX_VALUE || Math.rint(number) != number) return null;
        return (int)number;
    }
    static String preparedUrl(Object hls, Object http, int port) {
        String preferred = localHls(hls, port);
        return preferred.isEmpty() ? localHls(http, port) : preferred;
    }
    private static String localHls(Object value, int port) {
        if (!(value instanceof String)) return "";
        String text = (String)value;
        if (text.length() > 2048 || text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0) return "";
        try {
            URI url = new URI(text);
            String path = url.getPath();
            if (!"http".equalsIgnoreCase(url.getScheme()) || !"127.0.0.1".equals(url.getHost())
                || url.getPort() != port || url.getUserInfo() != null || url.getFragment() != null
                || path == null || !path.endsWith(".m3u8") || path.contains("/../")
                || path.contains("/./") || path.indexOf('\\') >= 0) return "";
            return url.toASCIIString();
        } catch (Exception ignored) { return ""; }
    }
}
