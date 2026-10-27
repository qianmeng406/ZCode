/**
 * 材料组装层已下沉到 `@zcode/shared/oracle-review`：CLI 的 `zcode review` 与设置页
 * 需要同一套「哪些行属于这一轮」「怎么渲染进 prompt」的规则。这里只做同名再导出，
 * 调用方与测试的 import 路径保持不变。
 */
export {
  isOracleReviewableTurnState,
  findTurnHeaderByRef,
  collectTurnRowsFromWindow,
  assembleOracleTurnMaterial,
  extractTurnMaterialFromRows,
  renderOracleTurnMaterialText,
  describeMaterialCompleteness,
  visibleUserInputText,
  truncateWithEllipsis,
  type OracleReviewableTurnState,
  type OracleReviewTargetRef,
  type OracleTurnHeaderRef,
  type OracleUserInputEntry,
  type OracleAssistantTextEntry,
  type OracleToolCallEntry,
  type OracleTurnMaterial,
  type OracleTurnMaterialCompleteness,
  type OracleTurnMaterialBundle,
  type OracleMaterialFetchRowsBefore,
} from "@zcode/shared/oracle-review";
