// 基于 PerformanceObserver 的帧耗时统计 + 显存/JS 堆快照。

const MAX_SAMPLES = 240;

export class StatsMonitor {
  constructor() {
    this.supported = typeof PerformanceObserver !== 'undefined';
    this.samples = [];
    this.lastMs = 0;
    this.memory = { textureBytes: 0, bufferBytes: 0, budgetBytes: 0 };
    if (this.supported) {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'frame-render') this.#push(entry.duration);
          }
        });
        this.observer.observe({ entryTypes: ['measure'] });
      } catch {
        this.supported = false;
      }
    }
  }

  #push(ms) {
    this.samples.push(ms);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.lastMs = ms;
  }

  beginFrame() {
    this._t0 = performance.now();
    if (this.supported) performance.mark('frame-start');
  }

  endFrame() {
    if (this.supported) {
      performance.mark('frame-end');
      performance.measure('frame-render', 'frame-start', 'frame-end');
      // 防止 measure/mark 无限堆积
      if (performance.getEntriesByName('frame-render').length > MAX_SAMPLES * 2) {
        performance.clearMeasures('frame-render');
        performance.clearMarks('frame-start');
        performance.clearMarks('frame-end');
      }
    } else {
      this.#push(performance.now() - this._t0);
    }
  }

  setMemory(textureBytes, bufferBytes, budgetBytes) {
    this.memory = { textureBytes, bufferBytes, budgetBytes };
  }

  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    return {
      lastMs: this.lastMs,
      avgMs: avg,
      p95Ms: p95,
      fps: avg > 0 ? 1000 / avg : 0,
      textureBytes: this.memory.textureBytes,
      bufferBytes: this.memory.bufferBytes,
      budgetBytes: this.memory.budgetBytes,
      heapBytes: heap,
      observerActive: this.supported,
    };
  }
}
