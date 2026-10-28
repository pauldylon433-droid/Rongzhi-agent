// 转账单状态变更信号：当某笔转账单在别处被确认 / 取消 / 改单时通知，
// 已挂载的共享确认卡据此自动回读数据库最新状态（旧卡无需手动刷新即可显示已取消等）。
import { ref } from 'vue'

const changedRefs = ref(new Set())
const version = ref(0)

export function useTransferSignal() {
  function notifyChange(refNo) {
    if (!refNo) return
    const next = new Set(changedRefs.value)
    next.add(refNo)
    changedRefs.value = next
    version.value += 1
  }
  function isChanged(refNo) {
    return !!refNo && changedRefs.value.has(refNo)
  }
  return { notifyChange, isChanged, version }
}
