package com.tvbus.engine;

/** Exact callback signatures declared in WPLAYP2P.apk classes.dex. */
public interface TVListener {
    void onInfo(String value);
    void onInited(String value);
    void onPrepared(String value);
    void onQuit(String value);
    void onStart(String value);
    void onStop(String value);
}
