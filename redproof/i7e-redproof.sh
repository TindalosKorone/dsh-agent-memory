#!/usr/bin/env bash
# 修正 4 红证：逐个把常数改回旧值，跑 test/scoring.test.mjs，确认**对应那条**边界用例变红。
set -u
run_case () {
  local name="$1" old="$2" expect="$3" file="redproof/i7e-red-${1}-disable.txt"
  # 当前值（用于恢复）
  local cur
  cur=$(grep -oE "export const ${name} = [0-9.]+" src/pure.ts | grep -oE '[0-9.]+$')
  node redproof/i7e-revert-const.mjs "$name" "$old" >/dev/null
  node node_modules/typescript/bin/tsc -p .
  node test/scoring.test.mjs > "$file" 2>&1
  echo "--- 回退 ${name} -> ${old} ---"
  grep -E "^✖" "$file" | head -3
  grep -qF "$expect" "$file" && echo "判红命中：$expect" || echo "!! 未命中预期红串：$expect"
  node redproof/i7e-revert-const.mjs "$name" "$cur" --restore >/dev/null
}
run_case SCALE_A 0.0187 "SCALE_A 改回 0.0187 即变红"
run_case SCALE_B 0.3420 "SCALE_B 改回 0.3420 即变红"
run_case WEAK_THRESHOLD 0.0363 "WEAK_THRESHOLD 改回 0.0363 即变红"
run_case STRONG_THRESHOLD 0.1476 "STRONG_THRESHOLD 改回 0.1476 即变红"
node node_modules/typescript/bin/tsc -p .
echo "=== 已全部恢复 ==="
