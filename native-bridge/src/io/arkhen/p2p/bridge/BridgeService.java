package io.arkhen.p2p.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import com.tvbus.engine.TVCore;
import com.tvbus.engine.TVListener;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Headless local control service; the native engine remains unloaded until configure. */
public final class BridgeService extends Service {
    private static final int CONTROL_PORT = 62731;
    private volatile boolean running;
    private volatile String state = "awaiting_configuration", event = "", playUrl = "";
    private volatile int playPort = 8902;
    private volatile long generation;
    private volatile boolean playbackRequested;
    private byte[] bridgeKey;
    private ServerSocket server;
    private TVCore core;
    private final BridgeDiagnostics diagnostics = new BridgeDiagnostics();
    private final ExecutorService clients = Executors.newFixedThreadPool(2);

    @Override public void onCreate() {
        super.onCreate();
        try {
            File keyFile = new File(getFilesDir(), "bridge-key");
            bridgeKey = readLimited(new FileInputStream(keyFile), 256).trim().getBytes(StandardCharsets.UTF_8);
            if (bridgeKey.length < 32) throw new IOException("Bridge key missing");
            NotificationManager manager = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
            manager.createNotificationChannel(new NotificationChannel("local-bridge", "P2P local bridge", NotificationManager.IMPORTANCE_LOW));
            startForeground(1, new Notification.Builder(this, "local-bridge")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("ARKHEN P2P Bridge").setContentText("Local bridge awaiting a session").build());
            server = new ServerSocket(CONTROL_PORT, 8, InetAddress.getByName("127.0.0.1"));
            running = true;
            Thread thread = new Thread(() -> {
                while (running) try { Socket socket = server.accept(); clients.execute(() -> handle(socket)); }
                catch (IOException error) { if (running) state = "control_error"; }
            }, "bridge-control");
            thread.setDaemon(true); thread.start();
        } catch (IOException error) { diagnostics.failure(error); state = "configuration_missing"; stopSelf(); }
    }
    @Override public int onStartCommand(Intent intent, int flags, int id) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        running = false; generation++;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        closeEngine(); clients.shutdownNow(); super.onDestroy();
    }
    private synchronized void closeEngine() {
        playbackRequested = false;
        if (core != null) { try { core.stopPlayback(); core.close(); } catch (Throwable ignored) {} core = null; }
        playUrl = "";
    }
    private JSONObject status() throws JSONException {
        return new JSONObject().put("engine", "tvbus").put("state", state).put("nativeLoaded", core != null)
            .put("event", event).put("playPort", playPort).put("playUrl", playUrl)
            .put("diagnostics", new JSONObject(diagnostics.snapshot()));
    }
    private synchronized void configure(JSONObject body) throws Exception {
        if (!"tvbus".equals(body.optString("engine", "tvbus"))) throw new IllegalArgumentException("Unsupported engine");
        String authUrl = body.getString("authUrl"), username = body.getString("username"), password = body.getString("password");
        URL auth = new URL(authUrl);
        if (!Arrays.asList("http", "https").contains(auth.getProtocol()) || auth.getUserInfo() != null || username.isEmpty() || password.isEmpty()) throw new IllegalArgumentException("Invalid engine configuration");
        int port = body.optInt("playPort", 8902); if (port < 1024 || port > 65535 || port == CONTROL_PORT) throw new IllegalArgumentException("Invalid play port");
        final long request = ++generation; closeEngine();
        playPort = port; event = ""; state = "initializing"; diagnostics.reset();
        TVListener listener = new TVListener() {
            private void update(String name, String value) {
                if (request != generation) return;
                event = name;
                Map<String, Object> fields = new HashMap<>();
                Map<String, String> fieldTypes = new LinkedHashMap<>();
                try {
                    Object parsed = new JSONTokener(value == null ? "" : value).nextValue();
                    if (parsed instanceof JSONObject) {
                        JSONObject payload = (JSONObject)parsed;
                        for (Iterator<String> keys = payload.keys(); keys.hasNext() && fieldTypes.size() < 32;) {
                            String key = keys.next();
                            if (key.matches("[a-zA-Z][a-zA-Z0-9_]{0,31}")) fieldTypes.put(key, valueType(payload.opt(key)));
                        }
                        for (String field : Arrays.asList("auth", "tvcore", "extra_errno", "errno", "peers", "hls", "http"))
                            if (payload.has(field)) fields.put(field, payload.opt(field));
                    }
                    diagnostics.shape(name, valueType(parsed), fieldTypes, parsed);
                } catch (JSONException ignored) { diagnostics.shape(name, "invalid-json", fieldTypes, null); }
                diagnostics.record(name, fields);
                if ("inited".equals(name)) state = diagnostics.initializationState();
                if ("prepared".equals(name) && playbackRequested) {
                    String url = BridgeDiagnostics.preparedUrl(fields.get("hls"), fields.get("http"), playPort);
                    if (!url.isEmpty()) { playUrl = url; state = "prepared"; }
                }
                if ("stop".equals(name)) { playbackRequested = false; playUrl = ""; state = diagnostics.playbackStoppedState(); }
                if ("quit".equals(name)) { playUrl = ""; state = "closed"; }
            }
            public void onInfo(String value) { update("info", value); }
            public void onInited(String value) { update("inited", value); }
            public void onPrepared(String value) { update("prepared", value); }
            public void onQuit(String value) { update("quit", value); }
            public void onStart(String value) { update("start", value); }
            public void onStop(String value) { update("stop", value); }
        };
        final TVCore created = new TVCore(); core = created;
        created.configure(authUrl, username, password, body.optString("broker"), port, listener);
        JSONObject options = body.optJSONObject("options");
        if (options != null) for (Iterator<String> keys = options.keys(); keys.hasNext();) {
            String key = keys.next(); created.option(key, options.getString(key));
        }
        // TVService$TVServer.run in the original APK initializes and runs on
        // the same thread. Preserve that contract for SDK thread affinity.
        new Thread(() -> {
            try {
                int code = created.initialize(getApplicationContext());
                if (request != generation) return;
                diagnostics.initializationReturn(code);
                if (code != 0) { closeEngine(); state = "initialization_failed"; return; }
                int result = created.loop();
                if (request == generation) { diagnostics.loopReturn(result); playUrl = ""; state = "closed"; }
            } catch (Throwable error) {
                if (request == generation) { diagnostics.failure(error); state = "engine_error"; }
            }
        }, "tvcore").start();
    }
    private static String valueType(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) return "object";
        if (value instanceof JSONArray) return "array";
        if (value instanceof Number) return "number";
        if (value instanceof Boolean) return "boolean";
        if (value instanceof String) return ((String)value).matches("-?[0-9]{1,10}") ? "numeric-string" : "string";
        return "other";
    }
    private void handle(Socket socket) {
        try {
            Socket connection = socket;
            connection.setSoTimeout(5000);
            InputStream input = connection.getInputStream(); String first = line(input);
            if (first == null) return;
            String[] parts = first.split(" ");
            Map<String,String> headers = new HashMap<>(); String value;
            for (int count = 0; count < 32 && (value = line(input)) != null && !value.isEmpty(); count++) {
                int colon = value.indexOf(':'); if (colon > 0) headers.put(value.substring(0,colon).trim().toLowerCase(Locale.ROOT), value.substring(colon+1).trim());
            }
            byte[] supplied = headers.getOrDefault("x-bridge-key", "").getBytes(StandardCharsets.UTF_8);
            if (!MessageDigest.isEqual(bridgeKey, supplied)) { reply(connection,401,new JSONObject().put("error","Unauthorized")); return; }
            if (parts.length != 3) { reply(connection,400,new JSONObject().put("error","Invalid request")); return; }
            if ("GET".equals(parts[0]) && "/status".equals(parts[1])) { reply(connection,200,status()); return; }
            if (!"POST".equals(parts[0]) || headers.containsKey("transfer-encoding")) { reply(connection,405,new JSONObject().put("error","Invalid method")); return; }
            int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
            if (length < 0 || length > 16384) { reply(connection,413,new JSONObject().put("error","Body too large")); return; }
            byte[] bytes = new byte[length]; int offset = 0;
            while (offset < length) { int read = input.read(bytes,offset,length-offset); if (read < 0) throw new EOFException(); offset += read; }
            JSONObject body = length == 0 ? new JSONObject() : new JSONObject(new String(bytes,StandardCharsets.UTF_8));
            if ("/configure".equals(parts[1])) configure(body);
            else if ("/start".equals(parts[1])) {
                synchronized (this) {
                    if (core == null) throw new IllegalStateException("Engine not configured");
                    String uri = body.getString("uri");
                    if (!uri.startsWith("tvbus://") || uri.length() > 8192 || uri.matches("(?s).*[\\x00-\\x20\\x7f].*"))
                        throw new IllegalArgumentException("Invalid TVBus stream URI");
                    playbackRequested = true; playUrl = ""; state = "starting"; diagnostics.clearPlayback(); core.play(uri,body.optString("option"));
                }
            } else if ("/stop".equals(parts[1])) { synchronized (this) { playbackRequested = false; if (core != null) core.stopPlayback(); playUrl = ""; state = "stopped"; } }
            else if ("/close".equals(parts[1])) { generation++; closeEngine(); state = "awaiting_configuration"; }
            else { reply(connection,404,new JSONObject().put("error","Route missing")); return; }
            reply(connection,200,status());
        } catch (Throwable error) {
            // Never log request bodies, callback payloads, credentials or stream URIs.
            diagnostics.failure(error);
            try { if (!socket.isClosed()) reply(socket,502,new JSONObject().put("error","Bridge operation failed").put("state",state).put("errorClass",error.getClass().getName())); }
            catch (Exception ignored) {}
        } finally {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }
    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int value;
        while ((value = input.read()) != -1 && value != '\n') { if (bytes.size() >= 2048) throw new IOException("Header too large"); if (value != '\r') bytes.write(value); }
        return value == -1 && bytes.size() == 0 ? null : bytes.toString("US-ASCII");
    }
    private static String readLimited(InputStream input, int limit) throws IOException {
        try (InputStream source = input) { ByteArrayOutputStream out = new ByteArrayOutputStream(); int value; while ((value = source.read()) != -1) { if (out.size() >= limit) throw new IOException("File too large"); out.write(value); } return out.toString("UTF-8"); }
    }
    private static void reply(Socket socket, int code, JSONObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        OutputStream out = socket.getOutputStream();
        out.write(("HTTP/1.1 "+code+" Result\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "+bytes.length+"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(bytes); out.flush();
    }
}
