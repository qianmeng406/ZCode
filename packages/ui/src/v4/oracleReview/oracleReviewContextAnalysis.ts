/** 上下文分析层已下沉到 `@zcode/shared/oracle-review`（见 oracleReviewMaterial.ts 说明）。 */
export {
  collectContextCandidates,
  renderContextCandidates,
  buildOracleContextAnalysisPrompt,
  parseOracleContextAnalysis,
  toContextCandidates,
  renderOracleContextAnalysis,
  type OracleContextCandidate,
  type OraclePriorContextItem,
  type OracleContextAnalysis,
} from "@zcode/shared/oracle-review";
