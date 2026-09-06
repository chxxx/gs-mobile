# cap=256 vs cap=1024 A/B 验证操作单（照抄即可）

> 目标：① 找到 cap 真正生效的视角；② 量化该视角的画质差异（PSNR/SSIM）；
> ③ 在手机同会话内对比两档帧率。

---

## 第 0 步：启动服务器

在 **`D:\study\project\gsplat.js`** 目录打开命令提示符，执行：

```cmd
npm run dev -- --host
```

看到类似 `Local: http://localhost:5173/` 与 `Network: http://192.168.x.x:5173/` 即可。
（`--host` 是必须的：不加的话手机无法通过局域网访问。）

---

## 第 1 步：桌面电脑 —— 找"cap 生效"的视角

1. 桌面浏览器打开：
   ```
   http://localhost:5173/?perf=1
   ```
2. 加载场景：页面顶部下拉选场景；若没有可选，直接把你的
   `point_cloud_quantised_half.ply`（QPLY）拖进页面中央虚线框。
   等到控制台出现 `First Frame: x.xxx s` 后再操作。
3. 打开控制台（F12 → Console），把下面这句**复制粘贴**回车：
   ```js
   __PERF__.probeCap()
   ```
   约 2 帧后它会打印两行结果。**先在全景视角跑一次**，预期：
   ```
   differing pixels: 0 / 5xxxxxx (0.000%)   maxΔ=0   meanΔ=0
   → identical at this view. ...
   ```
4. 用鼠标**贴近地面 / 树干 / 建筑表面**（画面里出现大片近距离色块时），再运行一次
   ```js
   __PERF__.probeCap()
   ```
   反复换视角运行，直到某次输出变成 `differing pixels: > 0`。**这个视角就是要用的测试视角**。

---

## 第 2 步：桌面电脑 —— 在该视角抓两张对比图

视角找到后（此时 cap 被探针切回了 256），控制台**依次**执行：

```js
__PERF__.setMaxSplatSize(1024)
__PERF__.captureFrame("cap1024")
```
等 **3 秒**（让下载完成）再执行：
```js
__PERF__.setMaxSplatSize(256)
__PERF__.captureFrame("cap256")
```
等 3 秒。两张 PNG（`cap1024_时间戳.png` / `cap256_时间戳.png`）会自动下载到
**浏览器默认下载文件夹**（Edge/Chrome 一般是 `C:\Users\<你的用户名>\Downloads`）。
**两次截图之间绝对不要动相机和窗口大小。**

---

## 第 3 步：查看对比

### 3A. 数值对比（命令）

在命令提示符中执行（先 `cd` 到下载目录，脚本会自动找最新的两张）：

```cmd
cd C:\Users\<你的用户名>\Downloads
python D:\study\project\gsplat.js\tools\compare_images.py
```

预期输出形如：
```
comparing  .\cap256_xxx.png  vs  .\cap1024_xxx.png
resolution 3200x1662
  PSNR[R] = 60.xx dB
  ...
  PSNR[RGB] = xx.xx dB
  SSIM     = 0.99xx
```

### 3B. 肉眼对比

把两张 PNG 分别拖到浏览器新标签页里放大对比，重点看**近景大高斯边缘**：
- 两张一样 → 无损；
- 256 那张边缘出现"硬切/发糊" → 有明显代价，考虑改用 384。

---

## 第 4 步：手机 —— 帧率 A/B（同一视角、同一会话、静止）

1. 手机与电脑连**同一个 Wi-Fi**，浏览器打开（IP 以第 0 步打印的 Network 地址为准）：
   ```
   http://192.168.x.x:5173/?perf=1
   ```
2. 同样加载场景（或拖入文件）。
3. 先跑一次 `__PERF__.probeCap()` 并**贴近物体**，确认当前视角 `differing pixels > 0`
   （这样帧率差异才可能显现）。保持相机不动。
4. 依次执行（每段之间停 5 秒看手机是否发热降频）：

   ```js
   __PERF__.setMaxSplatSize(256)          // 默认档
   __PERF__.scanResolution([4], 5)        // 记录 scale=4 的 fps
   ```
   ```js
   __PERF__.setMaxSplatSize(1024)         // good 档
   __PERF__.scanResolution([4], 5)        // 再记录 scale=4 的 fps
   ```

---

## 第 5 步：发给我什么

把下面内容原样贴回聊天即可（缺的标"-"）：

```
【设备】电脑：____（系统/浏览器/显卡）   手机：____（型号/浏览器）
【场景】____（名称/点数，如 truck 280K）
【探针】全景视角：differing pixels = ____ / ____
       近景视角：differing pixels = ____ / ____（maxΔ=____）
【画质】compare_images 输出：
       PSNR[RGB] = ____ dB    SSIM = ____
       肉眼判断：____（一样 / 256 边缘略硬 / 明显可见）
【手机帧率】cap256: scale4 ≈ ____ fps
           cap1024: scale4 ≈ ____ fps
```

我会依据这几行直接给出"默认档定稿 or 需要调成 384"的结论。
