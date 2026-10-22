import { ref } from 'vue'

// 全局数据刷新信号：转账成功（余额 / 流水 / 月度统计都会变化）后由转账面板触发，
// 各数据区域监听版本号变化重新加载，保证页面数字互相一致。
const version = ref(0)

export function useDataRefresh() {
  function refresh() {
    version.value += 1
  }
  return { refresh, version }
}
