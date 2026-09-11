# 性能回归脚本

性能脚本位于 `enterprise/scripts/perf/`，运行时输出写入 `.runtime/perf-baselines/`，默认不会提交到仓库。

脚本使用 mock 上游隔离网关开销，结果仅用于本地回归与版本对比，不代表任何部署环境的 SLA。

常用命令：

```bash
cd enterprise
bash scripts/perf/run-gateway-baseline.sh
```
