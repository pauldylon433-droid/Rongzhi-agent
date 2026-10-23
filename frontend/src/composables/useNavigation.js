import { ref } from 'vue'

// 页面导航单例：左侧导航、总览「展开工作区」、AI 工作区「返回总览」共用同一份当前视图状态。
const VIEW_KEYS = ['overview', 'assistant', 'accounts', 'bill', 'cards', 'subscriptions', 'tasks']

const currentView = ref('overview')

export function useNavigation() {
  function navigate(view) {
    if (VIEW_KEYS.includes(view)) currentView.value = view
  }
  function openAssistant() {
    currentView.value = 'assistant'
  }
  function backToOverview() {
    currentView.value = 'overview'
  }
  return { currentView, navigate, openAssistant, backToOverview }
}
