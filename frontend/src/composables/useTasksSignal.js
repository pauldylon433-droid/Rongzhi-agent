import { ref } from 'vue'

// 跨场景任务刷新信号：AI 助手启动「订阅审查」任务后 bump，任务区（总览摘要 / 工作区 / 最近任务页）
// 监听版本号变化重新拉取，避免聊天面板与任务区之间用直接引用耦合。
const version = ref(0)

export function useTasksSignal() {
  function bump() {
    version.value += 1
  }
  return { version, bump }
}
