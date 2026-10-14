package com.tvbus.engine;

import android.content.Context;

/**
 * Java facade over the real handle-based JNI exports in the supplied libtvcore.
 * It deliberately does not load NativeUtil/ijkplayer or the protected login.
 * JNI and account authentication were verified. Playback remains subject to
 * the SDK's signing-certificate check; this facade does not bypass it.
 */
public final class TVCore {
    static { System.loadLibrary("tvcore"); }
    private final long handle;
    private TVListener listener;

    public TVCore() {
        handle = initialise();
        if (handle == 0) throw new IllegalStateException("TVCore allocation failed");
    }

    private native long initialise();
    private native int init(long value, Context context);
    private native int run(long value);
    private native void quit(long value);
    private native void setAuthUrl(long value, String url);
    private native void setUsername(long value, String username);
    private native void setPassword(long value, String password);
    private native void setMKBroker(long value, String broker);
    private native void setOption(long value, String key, String option);
    private native void setPlayPort(long value, int port);
    private native void setServPort(long value, int port);
    private native void setRunningMode(long value, int mode);
    private native void setListener(long value, TVListener callbacks);
    private native String getVersion(long value);
    private native void start(long value, String uri);
    private native void start2(long value, String uri, String option);
    private native void stop(long value);

    public void configure(String authUrl, String username, String password, String broker,
                          int playPort, TVListener callbacks) {
        listener = callbacks;
        setListener(handle, callbacks);
        setPlayPort(handle, playPort);
        setServPort(handle, 0);
        setRunningMode(handle, 1); // TVService$TVServer.run: classes.dex 0x701058.
        setAuthUrl(handle, authUrl);
        setUsername(handle, username);
        setPassword(handle, password);
        if (broker != null && !broker.isEmpty()) setMKBroker(handle, broker);
    }
    public int initialize(Context context) { return init(handle, context); }
    public int loop() { return run(handle); }
    public void option(String key, String value) { setOption(handle, key, value); }
    public void play(String uri, String option) {
        if (option == null || option.isEmpty()) start(handle, uri);
        else start2(handle, uri, option);
    }
    public void stopPlayback() { stop(handle); }
    public void close() { quit(handle); listener = null; }
    public String version() { return getVersion(handle); }
}
