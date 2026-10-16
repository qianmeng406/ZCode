// bench-agent-linux 纯统计函数。失败样本由调用方剔除后才传入。
export const P95_MIN_N = 20;

function mean(xs) {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * 计算 raw samples 的统计。输入毫秒数组（已剔除失败/超时）与 firstSample。
 * n < 20 时不输出 p95。
 */
export function computeStats(samplesMs, { firstSample = null } = {}) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    return { n: 0, samples: [], firstSample, median: null, min: null, max: null, mean: null };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  // 偶数个样本取中间两值平均。
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const stats = {
    n,
    samples: [...samplesMs],
    firstSample,
    median,
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(mean(sorted) * 10) / 10,
  };
  if (n >= P95_MIN_N) {
    // 线性插值 p95：index = 0.95 * (n - 1)。
    const idx = 0.95 * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    stats.p95 = lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
  }
  return stats;
}
