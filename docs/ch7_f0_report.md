# 第 7 章 · F0（口径归一与 Gen3 定位）阶段报告

> 生成：2026-10-02。提交号：见 §6。约束来源：通用约束（最终阶段）+ F0 任务清单。
> 产物：`_tmp_ch7probe/out/f0_table.md`（设备×rounds×臂 总表）、`out/f0_links.txt`（真机链接）、
> `out/fps_hist.csv`（393 份原始记录的时间序列）。

## 1. 三行结论

1. **口径归一是"没超过历史最好值"的主因**：`lr-full 104.6`（09-30，Mali-925，`arm=lr`，**rounds=3**）之后，
   同机同协议（rounds=3）的 `lr+notx+nocolortx` 已达 **108.5±1.8（+3.7%）** ⇒ **已经超过**；而 10-01 之后的所有
   新数字（含本轮 O2/O3）都是 **rounds=1** 的筛选口径，**与 rounds=3 不可横向比较**。
2. **消融的"正向"是相对各自基线** ⇒ 叠加时边际收益递减甚至转负：Mali 上 `frag 76.4 → +prep 86.3(+13%)`，
   但 `lr+notx+nocolortx 108.5 → +prep 99.8(−8%)` ✗。机制见 §3。
3. **O3（`&slot=1`）功能正确但真机性能崩坏**（`frame_ms` 0.15→2.3、fps −31%~−66%）⇒ 按 F0/F7 约定**放弃**，
   代码保持缺省关闭；本轮已删除全部调试探针（`prepdbg/armdbg/prep-dbg3/prep-bind`，159 行）。

## 2. 数据（F0.1 总表节选；完整表见 `out/f0_table.md`）

### rounds=3（**可进论文**）

| 设备(SoC) | base | frag | frag+notx+nocolortx | lr | lr+notx+nocolortx | lr-frozen（上限） | flux |
|---|---|---|---|---|---|---|---|
| **Snapdragon 8 Gen 3 / Adreno 750**（Gen3，微信 XWEB） | 69.5 | 85.1 | —（待补） | 85.8 | —（待补） | **112.9** | 115.4 |
| **Snapdragon 8 Gen 2 / Adreno 740**（Chrome） | 44.1 | 62.0 | 72.0 | 58.5 | 68.1 | 93.6 | 127.2（微信） |
| **ARM Mali-925**（MediaTek；Chrome / 微信） | 59.1 | 82.6 | 108.5（微信） | 104.6（微信） | 108.5（微信） | — | — |

### rounds=1（**仅筛选/定位，禁止与上表横向比**）

| 设备 | base | frag+notx+nocolortx | +prep | +prep+mrt0 | lr+notx+nocolortx+prep |
|---|---|---|---|---|---|
| Adreno 740 | 43.6 | 72.3~73.3 | 67.4~68.3（**−6%**） | 64.3 | 64.5 |
| Mali-925 | 58.9 | 76.4~76.6 | **85.8~86.3（+12~13%）** | 84.4 | 99.8（−8% vs lr 的 108.5） |

### O3（`&slot=1`）留档（F0.5：不修复）

| 设备 | S2 | +prep（O2） | **+prep+slot（O3）** | +prep+slot+mrt0 | lr+prep+slot |
|---|---|---|---|---|---|
| Adreno 740 | 72.3 | 68.3 | **24.5**（frame_ms 2.50，sync_ms 37.3） | 22.2（3.60 / 40.5） | 40.0 |
| Mali-925 | 76.6 | 85.8 | **53.1**（2.30 / 15.6） | 47.9（2.45 / 16.4） | 92.2 |

⇒ `sync_ms` 与 `frame_ms` 同时暴涨、且桌面只慢 ~3% ⇒ 指向**移动驱动对"无 divisor=1 属性、靠 `gl_InstanceID` 取槽位"
的实例化慢路径**，而非排序表上传停顿（后者是 F0.5 待验假说，见 §5）。

## 3. 机制解释

* **为什么消融叠到 LR 上会转负**：预处理 pass 的代价 ≈ **每 splat 固定**（写 T0+T1 ≈ 24 B/splat ⇒ 610k ⇒ **每帧
  ±15 MB 显存流量** + 一次全量 pass），而它省下的 ALU 随基线变快而变小。`frag` 臂 ALU 重 ⇒ +13%；`lr` 臂 ALU 已很轻
  ⇒ 净负。Adreno 740 亦同（顶点路径强、带宽相对紧 ⇒ 全程 −6~−8%）。
* **为什么 `lr-frozen` 仍是上限**：冻结 = 取消逐帧颜色生产遍 ⇒ 只吃主 pass，因此比任何非冻结臂都快 30% 左右
  （Gen3 85.8→112.9、Adreno740 58.5→75.8、Gen2 68.1→93.6）。按约束 4，它只作上限参照。
* **为什么 rounds=1 不能横向比**：`offscreen_fps_mean` 只是**同一会话内 5 次运行**的均值 ⇒ 会话间漂移（温度墙、
  频率、后台）未被平均；`std` 小（±0.3~1.4）只反映会话内稳定度，不反映会话间误差。

## 4. F0 各子任务状态

| 子任务 | 状态 |
|---|---|
| F0.1 ingest + 设备×rounds×臂 总表 | **表已生成** ✅（`out/f0_table.md`，341 条有效记录）；**逐轮 JSON 入库待做**（`ch7_batch.py ingest` 需确认平台 id，见 §5） |
| F0.2 Gen3 rounds=3 ABAB 六臂 | **链接已生成** ✅（`out/f0_links.txt` A1~A6）⇒ 待真机跑 |
| F0.3 瓶颈诊断（resscale/drawfrac） | **链接已生成** ✅（B1~B3，rounds=1）⇒ 待真机跑 |
| F0.4 三种轨迹下的可见性比例 v | **源码位置已定位** ✅：主 VS 剔除条件 = `RenderProgram.ts:1202`（另一分支 `1303`），预处理 FS = `418`，**保护带均为 1.2**（`clip = 1.2 * pos2d.w`）；统计脚本待写（方案见 §5） |
| F0.5 O3 留档 + texSubImage2D 假说 | **sync_ms/frame_ms 已留档** ✅（§2 表）；"只上传一次后冻结"实验待加 1 个开关（`&slotfreeze=1`）后跑 1 臂 |
| F0.6 删除调试探针 | **已完成** ✅（159 行；`PREP_DBG/ARM_DBG/prep-dbg3/prep-bind` 无残留；`tsc` 0 错） |

## 5. 下一步（给方案的输入）

1. **入库**：确认平台 id 后执行
   `python tools/ch7_batch.py ingest --platform <id> --group auto --pattern "o2-*.txt"`，
   再对 `o3-*.txt` / `f0-*-r3.txt` 同样处理；`python tools/ch7_verify.py verify --write-index docs/ch7_raw_index.csv`。
   *待确认*：Mali-925（MediaTek）入库到 `d9400-xweb` 还是新建 `mali925-*`？（现有枚举无 mali）
2. **F0.2/F0.3 真机跑批**：Gen3（Adreno 750，微信 XWEB）优先，A1~A6 按 ABAB；随后 Gen2、Mali。
3. **F0.4 v 统计（不改渲染）**：在 `RenderProgram` 里加 `?viscull=1` 的**CPU 侧**统计（复用 worker 已有的 CPU 位置 +
   当前 viewProj），逐 splat 判定 `1202` 行的条件（保护带 1.2），输出 `v = 通过剔除的 splat 数 / N`；
   三种轨迹：基准位姿、`spin=0.2`、`spin=1`。**注意**：该统计只读不写、不改任何绘制路径。
4. **F0.5 假说验证**：加 `&slotfreeze=1`（排序表仅首帧上传）后跑 **1 条** `prep+slot` 臂；若 `sync_ms` 不回落 ⇒
   排除"上传停顿"，与大设备结论（`gl_InstanceID` 慢路径）一致。
5. **O2-lite（把 prep 变成两台都正向的建议方案）**：预处理只写几何 T0、颜色复用 O1 颜色纹理、T0 半精度压到
   8 B/splat（每帧流量 24→8 B/splat）。

## 6. 提交

本文件与探针清理一并提交（见 git log 最后一条）。
