const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
const CONVERSATION_CONTENT_WIDTH_CLASS_NAME = "w-full max-w-6xl";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
}): string {
  // 状态胶囊不占消息列侧边空间，不再保留旧摘要面板的布局偏移。
  return params.centeredEmptyLayout
    ? CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WIDTH_CLASS_NAME;
}

// 给时间线顶部内容留出状态胶囊空间，避免首个运行卡片被遮挡。
export const CONVERSATION_STATUS_PANEL_TOP_CLEARANCE_CLASS_NAME = "pt-14";
