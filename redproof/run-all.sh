#!/data/data/com.termux/files/usr/bin/bash
# 全量用例逐个文件直跑（本机 `node --test` 是坏的：逐个 `node test/x.test.mjs` 才能跑）。
# 用法：bash redproof/run-all.sh [证据文件]
# 输出：每文件 pass/fail 计数 + 汇总；失败用例原文落证据文件。
set -u
cd "$(dirname "$0")/.." || exit 1
OUT="${1:-redproof/full-suite.txt}"
: > "$OUT"
FILES=(
  protocol cap pure scoring recall triage lossless storage prune inject
  loose-inject anchor graph calibrate import-gotchas header columns description
)
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
echo "TOTAL | pass=$tp | fail=$tf" | tee -a "$OUT"
[ "$tf" = "0" ] || exit 1
