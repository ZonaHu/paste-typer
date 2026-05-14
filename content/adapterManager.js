if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

/**
 * Adapter Manager
 * 
 * 管理适配器的选择和切换
 */

class AdapterManager {
  constructor() {
    this.adapters = [];
    this.registerAdapter(GoogleDocsAdapter);
    this.registerAdapter(StandardInputAdapter);
  }

  registerAdapter(AdapterClass) {
    this.adapters.push(AdapterClass);
  }

  getAdapter() {
    debug.log('[AdapterManager] Checking adapters...');
    for (const AdapterClass of this.adapters) {
      const adapterName = AdapterClass.name;
      const detected = AdapterClass.detect();
      debug.log('[AdapterManager]', adapterName, 'detect():', detected);
      if (detected) {
        debug.log('[AdapterManager] Using adapter:', adapterName);
        return new AdapterClass();
      }
    }
    // Fallback to StandardInputAdapter if no specific adapter is detected
    debug.log('[AdapterManager] No specific adapter detected, using StandardInputAdapter');
    return new StandardInputAdapter();
  }
}

const adapterManager = new AdapterManager();

