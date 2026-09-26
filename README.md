# WebXR 多视图渲染 Demo

纯前端、零构建的多视图渲染演示：单眼 / 双眼 / 四视图，支持纹理图层、投影图层、
圆柱图层，实时展示渲染耗时与显存占用，并对各类异常场景提供降级与恢复。

## 运行

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

无 XR 设备时自动进入「桌面模拟模式」，所有视图模式与降级逻辑均可直接验证；
连接头显（或浏览器 WebXR 模拟插件）后可点击「进入沉浸式 VR」。

## 技术栈

- **WebXR**：`immersive-vr` 会话、`layers` 特性探测（`XRProjectionLayer` / `XRCylinderLayer`）、
  会话 `end` / `visibilitychange` 事件处理
- **WebGL**：WebGL2 优先，降级 WebGL1，再降级 Canvas2D；`EXT_disjoint_timer_query_webgl2` GPU 计时
- **Canvas**：离屏 Canvas 生成棋盘格纹理与等距柱状全景图
- **PerformanceObserver**：`measure` 采样 CPU 帧耗时，`longtask` 监控卡顿

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `js/main.js` | UI 绑定、渲染循环调度、故障注入、统计刷新 |
| `js/renderer.js` | GL 上下文管理、视图布局、纹理格式探测、显存预算与降级、GPU 计时 |
| `js/layers.js` | 投影 / 纹理 / 圆柱三种图层的几何体、着色器与绘制 |
| `js/xr-session.js` | XR 会话生命周期、layers 模式与 XRWebGLLayer 合成模式、中断恢复 |
| `js/stats.js` | PerformanceObserver 帧耗时统计 |
| `js/math.js` | mat4 工具（透视 / 视图 / 变换） |

## 验收标准对照

| 验收项 | 实现与验证方式 |
| --- | --- |
| 多视图渲染正确 | 单眼全屏；双眼左右半屏带瞳距视差；四视图 2×2 分别朝向前/右/后/左 |
| 各类图层正确 | 投影层=全屏渐变网格背景；纹理层=旋转棋盘格立方体；圆柱层=360° 全景，均可独立开关 |
| 渲染耗时展示准确 | PerformanceObserver measure 采样 CPU 耗时；GPU 计时扩展可用时展示 GPU 耗时，否则显示「不支持」 |
| 浏览器不支持 layers 有降级 | 探测 `XRWebGLBinding`/`XRProjectionLayer` 与 `enabledFeatures`，不支持时降级 XRWebGLLayer 投影合成并提示；可用「模拟浏览器不支持 layers」验证 |
| 视图数量不匹配有提示 | 请求视图数与 `pose.views.length` 不一致时日志+状态栏提示并自动适配；「模拟视图数量不匹配」可验证 |
| 纹理格式不支持 | RGBA16F → RGBA8 逐级探测，全部失败则禁用纹理/圆柱图层；「模拟纹理格式不支持」可验证 |
| 显存不足有降级 | 显存占用超预算时逐级降级：减视图 → 关圆柱层 → 关纹理层；「模拟显存不足」可验证 |
| 会话中断可恢复 | `end` 事件保存会话状态，自动回退桌面模式，「恢复会话」按原状态重连；「模拟会话中断」可验证 |
| 降级方案可用 | WebGL2→WebGL1→Canvas2D 三级渲染降级；XR layers→XRWebGLLayer 合成降级；显存/纹理降级后渲染不中断 |
| 可视化准确 | 状态栏实时显示后端、实际视图数、CPU/GPU 耗时、FPS、显存占用/预算、JS 堆、降级原因 |
