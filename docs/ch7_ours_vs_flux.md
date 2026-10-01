# 本文实现 vs Flux-GS：逐项对照 + 新方案设计要点

> 生成：2026-10-01。左边=`gsplat.js`（本文，`src/renderers/webgl/programs/RenderProgram.ts` 等），
> 右边=`flux-gs-project-gh-pages/render_shared/main.js`（Flux-GS 官方 WebGL 渲染器，108 KB；13 个场景页共用）。
> 同会话实测取自 `thesis_project/data/ch7_measurements/raw/`：
> `g3_20261001_162706.txt`（本文 `arm=lr-frozen`）与 `g3_20261001_163043.txt`（`engine=fluxgs`）——
> 同一台 **Snapdragon 8 Gen 3 / Adreno 750（微信 XWEB）**、同一 `pose_src=flux`、同 `res=1600x1063`、garden 610k vs 739k 点。

## 1. 逐项对照

| # | 项 | 本文 | Flux-GS | 差 / 含义 |
|---|---|---|---|---|
| 1 | **颜色求值位置与时机** | 片元/顶点着色器**每帧**按 `cameraPosition` 求（`RenderProgram.ts:970-1001`）；另有"生产遍"把结果写进颜色缓存 | 顶点着色器**每帧**按 `camPos` 求（`main.js:1233/1358-1366`） | **同类**：都是每帧视角相关求值，都无烘焙 |
| 2 | **SH 阶数（视角相关度）** | **l=0..3**，16 系数/通道（48 half/点） | **l=0..1**，4 系数/通道（12 float/点，`main.js:1248-1268`；C2/C3 与 12 系数全量版**注释掉**） | **最大口径债**：我们算 4× 的系数项 |
| 3 | 每帧每点 **SH 取样** | packed：**6**（3 通道×2 纹素）；`lr=1`：**2**（rank+DC） | **3**（3 通道×1 纹素，RGBA32F） | lr 已少于 flux，但换来 315 次/点基累加 |
| 4 | 每点**总取样**（生产遍/VS） | frag **18** / lr **14** | **5**（cen+cov 2 + SH 3） | 我们多出的 7 次=位置 2 + **变换 5**；另 4 次=colorTransform（`u_colorTransformEnabled` 可关） |
| 5 | **per-splat 变换** | **无条件**取 1×index + 4×mat4（`RenderProgram.ts:364, 402-405`） | **0**（变换在加载期烘焙进位置/协方差） | 平台无关的**白拿 5 次/点**：可加 `u_useTransform` 门控 |
| 6 | **颜色缓存** | **有**：RGBA16F `u_colorTex`，可 `?shfreeze=N` 冻结（前 N 帧后不再重算） | **无**：每帧重算 | 静态机位下冻结=**逐位等价**（可证明）；动态才有误差 |
| 7 | **排序触发** | `SortWorker.ts:291-298`：`viewProj` 任一元素变化即重排（值级，无死区） | `main.js:561-572`：`|dot−1|<0.01` ⇒ **≤8.11°** 复用旧序，且**纯平移不触发** | 动态场景下我们多排序（更"正确"），flux 更省 |
| 8 | **SH 纹理显存** | 缺省 3×RGBA32UI=**58.6 MB**（96 B/点）；`lr=1` 1×RGBA32UI=**19.5 MB**（32 B/点） | 1×RGBA32F=**48 B/点**（garden 739k ⇒ 35.5 MB） | flux 每点比我们 lr 贵 1.5×、比缺省便宜 2×；**但 flux 只存 l=1** |
| 9 | 主纹理布局 | RGBA32UI，2 纹素/点（cen+cov），2048 宽（`QPLYLoaderUtils.ts:234-241`） | **同构**（`main.js:449-451`，2048 宽，2 纹素/点） | 同一 antimatter15 血统 ⇒ 位置/协方差成本同源 |
| 10 | **加载期** | QPLY 解析：Gen3 `parse_ms` **3927–4880**（低秩路径跳过 C@B），`first_frame_ms` **5337–6668** | TMC3(MPEG G-PCC) WASM 解 xyz + 逐点 MLP 推理 + 2 次纹理上传（全在 worker）：`decode_ms` **46022–52049**，`first_frame_ms` **46054–52089**（13 景 11–52 s） | **同会话 7.5×**：我们 6.2 s vs flux 46–52 s |
| 11 | **文件体积** | QPLY garden **14.6 MB**（`bytes=14648886`） | `.mobilegs` **7.2 MB**（`bytes=7236483`）+ `storage_mb=6.95` | flux 压缩约 **2×**（代价：第 10 行的解码时间） |
| 12 | **神经组件** | 无 | 有：TCNN MLP(96→64→13) + 3×(16→64→{1,3,9}) + 4 层 offset MLP(23→12)（`main.js:1068-1118`） | 神经只用于**解码系数**，不用于逐帧渲染 |
| 13 | worker 架构 | 排序 worker + 低秩加载 worker | 解码 worker + 排序 worker | 同构 |
| 14 | GL 版本/采样 | WebGL2 / GLSL ES 3.00，NEAREST 无 mip | 同（`#version 300 es`，NEAREST） | 一致 |

## 2. 交给新方案的分析（按可行性排序）

1. **先把"阶数债"还掉（可比性）**：我们 l=3、flux l=1 ⇒ 任何"每帧成本"对比都会被阶数解释。建议加一个 **`?shdeg=1` 截断臂**（数据侧仍有 48 half，但只解释 l=1 的 3 个系数）⇒ 立刻变成苹果对苹果；`lr=1` 已是这条路的起点（取样 2 次）。
2. **production 遍的 7 次"位置类"读取是固定税**：位置 2 + 变换 5（`#5`）。其中 **变换 5 次/点是无条件付出的**，若调色板恒等则可省 ⇒ 加门控或加载期烘焙，**与设备无关**。
3. **colorTransform 4 次/点可关**（`u_colorTransformEnabled`）：若本场景不需要颜色变换，这是一个现成的 4/18 = 22% 取样削减。
4. **颜色缓存是"合法杠杆"但要两段论证**：① 静态机位=逐位等价（补像素级对账）；② 动态机位给"误差 ≤Y 级 @ Δθ ≤Z°"曲线。论文写法："以有界误差换 X% 帧率"。
5. **排序死区**：flux 用 8.11° 死区（且纯平移不排）省成本；我们值级重排。若新方案要省 CPU/带宽，可以引入死区作为**消融项**，但要明确它是有损的。
6. **加载期与体积是两条独立轴**：flux 用 G-PCC+MLP 换 2× 体积、代价 46–52 s；我们 14.6 MB / 6.2 s。若目标是"低体积 + 低加载"，可走 **低秩 + 区间量化**（保持无神经解码），不必复制 flux 的 MLP 路线。

## 3. 取样账（把 18 → 尽量小，逐项可减性）

| 项 | 次数(frag) | 次数(lr) | 可减性 |
|---|---|---|---|
| 位置 cen + cov（含 DC 字节/alpha） | 2 | 2 | **不可减**（核心几何+不透明度） |
| 变换 index + mat4 | 5 | 5 | **可减到 0**（门控/烘焙）← 优先 |
| colorTransform index + mat4 | 1+4 | 1+4 | **可关**（`u_colorTransformEnabled=0`） |
| SH/权重 | 6 | 2 | l=3→l=1 可再降到 3（frag）/2（lr） |

⇒ 新方案的最小可达"每帧每点"：**2（位置）+ 0（变换）+ 0（颜色变换）+ 2（l=1 权重）≈ 4 次**，
与 flux 的 5 次同量级 ⇒ **再谈帧率才站得住**。

## 4. 本轮代码整理（只读核查 + 清理）

**已删除（没用）**
- 根目录/`gsplat.js` 的一次性 scratch：`_cf2.exe`、`_flux.txt`、`_flux_sh.txt`、本轮所有 `_g*.txt`/`_fx_*.txt`；
- `site-dist/assets/*.js`：6 个**被跟踪的构建产物**，而 `site-dist` 已在 `.gitignore`（`.gitignore:189`）⇒ 提交该删除，避免"陈旧产物入库"。

**已修并提交（有用）**
- `tsconfig.json` 增 `"moduleResolution": "bundler"`：此前 `npx tsc --noEmit` 对 3 个 `*.test.ts` 报 `TS2792 Cannot find module 'vitest'`（vitest 已安装、`npm test` 全绿）⇒ 现在 **0 报错**。`npm run build` 不含 tsc，故该修复只影响手动类型检查。

**保留但需你决策（不算死代码）**
- `src/loaders/QPLYLoaderUtils.lowrank.test.ts`：**3 个测试全部 skip**（缺低秩 QPLY 固件）。要么补固件启用，要么删——请指定。
- 实验性开关（`?shfmt=`/`?shpackf16=`/`?shpass=`/`?shdeg=`/`?nosh=`/`?noct=`/`?sortlag=` 等）：**是活的测量杠杆**（协议里被引用），未删。

## 5. 证据索引

| 事实 | 出处 |
|---|---|
| flux 每帧求 SH（l=1） | `render_shared/main.js:1233, 1248-1268, 1358-1366` |
| flux 无颜色缓存；片元只做 α 衰减 | `main.js:1378-1394` |
| flux 排序 8.11° 死区 | `main.js:561-572`（`|dot−1|<0.01`） |
| flux 首帧=G-PCC+MLP | `main.js:869-889`（TMC3）、`1051-1118`（Neural Decode Loop）、`1900-1929`（上传） |
| flux SH 纹理 12 float/点 | `main.js:455-465`（`texwidth_sh=8192`，3 纹素/点） |
| 本文生产遍/主 pass 取样 | `RenderProgram.ts:363-423`（生产遍）、`631-638`（SH packed）、`717-775`（主 pass） |
| 本文冻结语义 | `RenderProgram.ts:143-157, 2108`；臂标签 `1223-1225` |
| 本文排序无死区 | `SortWorker.ts:291-298` |
| 同会话加载期对比 | raw/`g3_20261001_162706.txt`（ours）vs `g3_20261001_163043.txt`（flux） |
