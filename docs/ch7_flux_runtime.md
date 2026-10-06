# Flux 页面**运行时**请求清单（实测，13 场景）

> 口径：`tools/ch7_flux_runtime_net.mjs`（CDP `Network.enable` + 禁缓存 + `Page.navigate`），
> 页面 `flux-gs-project-gh-pages/render_<scene>/index.html` 由本机 vite dev server 托管。
> 「本地字节」含 `@vite/client` 等 **dev 注入**（正式 gh-pages 部署不存在）。

| scene | `<scene>.json` 传输字节 | = MiB | 本地站点字节 | = MiB | 数据来源 | 远程请求数 | 总请求数 |
|---|---|---|---|---|---|---|---|
| garden | 7292354 | 6.95 | 140771 | 0.13 | https://huggingface.co | 1 | 9 |
| bicycle | 4999002 | 4.77 | 140619 | 0.13 | https://huggingface.co | 1 | 8 |
| flowers | 4943093 | 4.71 | 140619 | 0.13 | https://huggingface.co | 1 | 8 |
| stump | 3942990 | 3.76 | 140613 | 0.13 | https://huggingface.co | 1 | 8 |
| treehill | 4398340 | 4.19 | 140620 | 0.13 | https://huggingface.co | 1 | 8 |
| room | 2552143 | 2.43 | 140612 | 0.13 | https://huggingface.co | 1 | 8 |
| counter | 2432042 | 2.32 | 140619 | 0.13 | https://huggingface.co | 1 | 8 |
| kitchen | 3580982 | 3.42 | 140619 | 0.13 | https://huggingface.co | 1 | 8 |
| bonsai | 3243825 | 3.09 | 140614 | 0.13 | https://huggingface.co | 1 | 8 |
| truck | 2906202 | 2.77 | 140613 | 0.13 | https://huggingface.co | 1 | 8 |
| train | 3053624 | 2.91 | 140613 | 0.13 | https://huggingface.co | 1 | 8 |
| drjohnson | 2749970 | 2.62 | 140621 | 0.13 | https://huggingface.co | 1 | 8 |
| playroom | 1992949 | 1.90 | 140620 | 0.13 | https://huggingface.co | 1 | 8 |
| **合计** | **48087516** | **45.86 MiB** | **1828173** | **1.74 MiB** | — | — | — |

