// 基于 PerformanceObserver 的帧耗时统计
export class FrameStats {
  constructor() {
    this.samples = [];
    this.maxSamples = 120;
    this.fpsSamples = [];
    this._lastFrameTs = null;
    this.supported = typeof PerformanceObserver !== 'undefined';
    if (this.supported) {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'xr-frame') {
              this.samples.push(entry.duration);
              if (this.samples.length > this.maxSamples) this.samples.shift();
            }
          }
        });
        this.observer.observe({ entryTypes: ['measure'] });
      } catch (_) {
        this.supported = false;
      }
    }
    // 长任务监控（卡顿提示）
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.longtaskObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.onLongTask?.(e.duration);
          }
        });
        this.longtaskObserver.observe({ entryTypes: ['longtask'] });
      } catch (_) { /* 浏览器不支持 longtask，忽略 */ }
    }
  }

  beginFrame() {
    performance.mark('frame-begin');
    const now = performance.now();
    if (this._lastFrameTs !== null) {
      this.fpsSamples.push(now - this._lastFrameTs);
      if (this.fpsSamples.length > this.maxSamples) this.fpsSamples.shift();
    }
    this._lastFrameTs = now;
  }

  endFrame() {
    performance.mark('frame-end');
    try {
      performance.measure('xr-frame', 'frame-begin', 'frame-end');
    } catch (_) { /* mark 缺失时忽略 */ }
    performance.clearMarks('frame-begin');
    performance.clearMarks('frame-end');
    // 防止 measure 缓冲膨胀
    const m = performance.getEntriesByName('xr-frame');
    if (m.length > 200) performance.clearMeasures('xr-frame');
    if (!this.supported && this._lastFrameTs !== null) {
      // 无 PerformanceObserver 时用手动采样兜底
      this.samples.push(this.fpsSamples[this.fpsSamples.length - 1] || 0);
      if (this.samples.length > this.maxSamples) this.samples.shift();
    }
  }

  get avgMs() {
    if (!this.samples.length) return null;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  get fps() {
    if (!this.fpsSamples.length) return null;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    return avg > 0 ? 1000 / avg : null;
  }
}

export function fmtMs(v) { return v === null || v === undefined ? '-' : v.toFixed(2) + ' ms'; }
export function fmtFps(v) { return v === null || v === undefined ? '-' : v.toFixed(0); }
