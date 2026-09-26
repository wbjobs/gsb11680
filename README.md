# WebXR 多视图渲染演示

基于 **WebXR + WebGL2/WebGL1 + Canvas 2D + PerformanceObserver** 的多视图渲染 demo，
无构建步骤，纯 ES Module 静态页面。

## 运行

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080 （XR 会话需要 HTTPS 或 localhost）
```

## 功能

- **多视图渲染**：单眼 / 双眼 / 四视图。WebGL2 + `OVR_multiview2` 时走单次绘制的
  multiview 路径（纹理数组 + `gl_ViewID_OVR`），否则自动降级为逐视图分视口渲染。
- **三类图层**：纹理图层（漂浮四边形组）、投影图层（等距柱状天空球，对应
  `XRProjectionLayer` 的降级实现）、圆柱图层（120° 弧面，对应 `XRCylinderLayer`）。
- **性能面板**：`PerformanceObserver` 采集每帧 `measure` 耗时（last/avg/P95/fps），
  显存（纹理+顶点缓冲估算、预算）、JS 堆占用、渲染路径、视图数。
- **XR 会话**：`immersive-vr` 会话进入/退出/恢复，`local-floor`→`local`→`viewer`
  参考空间逐级降级。

## 异常处理与降级

| 场景 | 处理 |
| --- | --- |
| 浏览器不支持 WebXR / immersive-vr | 提示并保持 Canvas 预览模式 |
| 不支持 WebXR Layers | 提示，投影/圆柱图层以 WebGL 几何体降级渲染 |
| 不支持 WebGL2 / OVR_multiview2 | 降级 WebGL1 + 逐视图渲染 |
| 视图数量不匹配（请求数 > 扩展上限或 XR 实际视图数） | 横幅+日志提示，按设备能力降级渲染 |
| 纹理格式不支持（RGBA16F 不可渲染/不可过滤/上传失败） | 降级 RGBA8 并提示 |
| 显存不足（预算超限 / `webglcontextlost`） | 逐级降级：降纹理分辨率 → 关圆柱图层 → 关纹理图层 → 单视图；上下文恢复后自动降画质重建 |
| 会话中断（`end` 事件非用户触发、页面隐藏） | 暂停渲染，提供「恢复会话」按钮重新进入 |

面板上的「故障模拟」按钮可直接验证显存不足、上下文丢失、会话中断三条路径。

## 文件结构

- `index.html` / `css/style.css` — 页面、HUD、控制面板
- `js/main.js` — 应用入口、渲染循环、降级策略、事件接线
- `js/renderer.js` — 多视图渲染器（multiview / 逐视图）、显存预算
- `js/layers.js` — 纹理/投影/圆柱图层、纹理格式检测
- `js/xr-session.js` — XR 会话生命周期与视图匹配
- `js/stats.js` — PerformanceObserver 帧耗时与内存统计
- `js/math.js` — mat4 工具
