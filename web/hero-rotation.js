const itemKey = item => item ? `${item.kind}:${item.id}` : '';

/** Metadata and rendering stay in the app; rotation owns only its five-second clock. */
export class HeroRotation {
  constructor({getItems, getCurrent, select, isVisible = () => true, interval = 5000, setTimer = (callback,delay)=>globalThis.setTimeout(callback,delay), clearTimer = timer=>globalThis.clearTimeout(timer)}) {
    Object.assign(this,{getItems,getCurrent,select,isVisible,setTimer,clearTimer});
    this.interval=Number.isFinite(interval)&&interval>0?interval:5000;
    this.running=false;this.paused=false;this.timer=null;this.epoch=0;
  }
  #items() {
    const values=this.getItems(),seen=new Set();
    return (Array.isArray(values)?values:[]).filter(item => {
      if (!item || item.id == null || seen.has(itemKey(item))) return false;
      seen.add(itemKey(item));return true;
    });
  }
  #cancel() {
    this.epoch++;
    if (this.timer!==null) this.clearTimer(this.timer);
    this.timer=null;
  }
  start() {this.running=true;this.sync();}
  stop() {this.running=false;this.#cancel();}
  restart() {this.#cancel();this.sync();}
  setPaused(value) {
    const paused=Boolean(value);if (paused===this.paused) return;
    this.paused=paused;this.#cancel();this.sync();
  }
  // Catalogue pages can cause frequent renders. They must not restart the clock.
  sync() {
    if (!this.running || this.paused || !this.isVisible() || this.#items().length<2) {this.#cancel();return;}
    if (this.timer!==null) return;
    const epoch=this.epoch;
    this.timer=this.setTimer(() => {
      if (epoch!==this.epoch || !this.running) return;
      this.timer=null;
      if (!this.paused && this.isVisible()) {
        const items=this.#items(),current=itemKey(this.getCurrent());
        if (items.length>1) {
          const index=items.findIndex(item => itemKey(item)===current),next=items[(index+1)%items.length];
          // The selected title changes synchronously; optional details may load later.
          try {Promise.resolve(this.select(next)).catch(() => {});} catch { /* A failed optional detail must not stop the clock. */ }
        }
      }
      this.sync();
    },this.interval);
  }
}
