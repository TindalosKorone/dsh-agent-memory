#!/usr/bin/env bash
# 全量用例逐个文件直跑（本机 `node --test` 是坏的：逐个 `node test/x.test.mjs` 才能跑）。
# 用法：bash redproof/run-all.sh [证据文件]
# 输出：文件清单自检 + 实际文件数 + 每文件 pass/fail 计数 + 汇总；失败用例原文落证据文件。
set -u
cd "$(dirname "$0")/.." || exit 1
OUT="${1:-redproof/full-suite.txt}"
: > "$OUT"
FILES=(
  protocol cap pure scoring recall triage lossless storage prune inject
  loose-inject anchor graph calibrate import-gotchas header columns description
  release
)
# 清单自检：以磁盘上的 test/*.test.mjs 为准，缺谁报谁 —— 免得下次再加用例文件又漏（连漏两轮过）。
# 同时输出「实际文件数」，让 总数 与 实跑文件数 对得上。
actual=0
for f in test/*.test.mjs; do
  [ -f "$f" ] || continue
  actual=$((actual + 1))
  base=$(basename "$f" .test.mjs)
  case " ${FILES[*]} " in
    *" $base "*) ;;
    *) echo "清单漏项 | $f | 未列入 FILES" | tee -a "$OUT" ;;
  esac
done
listed=${#FILES[@]}
echo "文件清单 | 列名 $listed 个 | 磁盘实际 $actual 个" | tee -a "$OUT"
[ "$listed" = "$actual" ] || echo "清单与磁盘不一致 | 见上面的漏项（下面仍只跑 FILES 里的）" | tee -a "$OUT"

tp=0; tf=0
for name in "${FILES[@]}"; do
  f="test/${name}.test.mjs"
  [ -f "$f" ] || { echo "$name | MISSING" | tee -a "$OUT"; continue; }
  log=$(node "$f" 2>&1)
  p=$(printf '%s\n' "$log" | sed -n 's/^ℹ pass \([0-9]*\)$/\1/p' | tail -1)
  fl=$(printf '%s\n' "$log" | sed -n 's/^ℹ fail \([0-9]*\)$/\1/p' | tail -1)
  p=${p:-?}; fl=${fl:-?}
  line="$name | pass=$p | fail=$fl"
  echo "$line" | tee -a "$OUT"
  if [ "$p" != "?" ]; then tp=$((tp + p)); fi
  if [ "$fl" != "?" ]; then tf=$((tf + fl)); fi
  if [ "$fl" != "0" ] && [ "$fl" != "?" ]; then
    { echo "===== $name 失败明细 ====="; printf '%s\n' "$log" | sed -n '/failing tests/,$p'; } >> "$OUT"
  fi
done
echo "TOTAL | files=$actual | pass=$tp | fail=$tf" | tee -a "$OUT"
[ "$tf" = "0" ] || exit 1
