import { ref, computed } from 'vue'
import { fetchAccounts, fetchCards } from '../api/index.js'

// 全局查询范围单例：银行卡页选择某张卡后，驱动总览 / 交易流水 / 月度账单按该卡关联账户过滤，
// 并作为「当前卡」显式传给 AI 助手（服务端核验归属）。切换视图不丢失选择。
//
// 同步规则（唯一状态源 = selectedCard / selectedAccountId）：
// - 账户筛选下拉的「全部账户」= clear()（清除全局选卡，selectedAccountId 为 null）；
// - 下拉选择具体账户 = selectAccountById(accountId)，按该账户反查其卡片并写入同一份快照；
// - 银行卡页 select(card) 与上述两种方式写的是同一状态，各页面不维护第二份过滤状态。
// 选中卡只存前端快照（id / 关联账户 id / 卡种 / 掩码号），实际数据一律以接口回读为准。
const selectedCardId = ref(null)
const selectedCard = ref(null) // 选中卡快照：{ id, account_id, account_name, account_type, card_type, masked_card_number }

// 账户 / 卡片轻量缓存：仅供下拉展示与「账户 → 卡片」映射，不参与业务金额计算。
const accountsCache = ref(null)
const cardsCache = ref(null)
let accountsPromise = null
let cardsPromise = null

export function useCardSelection() {
  // 选择 / 清除某张卡；传 null 清除。card 需至少含 id 与 account_id、account_type。
  function select(card) {
    if (!card || typeof card.id !== 'number') {
      selectedCardId.value = null
      selectedCard.value = null
      return
    }
    selectedCardId.value = card.id
    selectedCard.value = {
      id: card.id,
      account_id: card.account_id,
      account_name: card.account_name,
      account_type: card.account_type,
      card_type: card.card_type,
      masked_card_number: card.masked_card_number,
    }
  }
  function clear() {
    selectedCardId.value = null
    selectedCard.value = null
  }

  // 读取账户列表 / 卡片列表（模块级缓存；force 用于重新拉取最新归属与掩码）
  async function ensureAccounts({ force = false } = {}) {
    if (force) accountsCache.value = null
    if (accountsCache.value) return accountsCache.value
    if (!accountsPromise) {
      accountsPromise = fetchAccounts()
        .then((list) => { accountsCache.value = list; return list })
        .finally(() => { accountsPromise = null })
    }
    return accountsPromise
  }
  async function ensureCards({ force = false } = {}) {
    if (force) cardsCache.value = null
    if (cardsCache.value) return cardsCache.value
    if (!cardsPromise) {
      cardsPromise = fetchCards()
        .then((list) => { cardsCache.value = list; return list })
        .finally(() => { cardsPromise = null })
    }
    return cardsPromise
  }
  function cardForAccount(accountId) {
    return (cardsCache.value || []).find((c) => c.account_id === accountId) || null
  }

  // 按账户设置全局查询范围；null / undefined = 全部账户。
  // 账户无对应卡片时仍记录账户范围（cardId 为空），不静默代换成其它账户。
  function selectAccountById(accountId) {
    if (accountId === null || accountId === undefined) {
      clear()
      return
    }
    const acc = (accountsCache.value || []).find((a) => a.id === accountId)
    if (!acc) {
      clear()
      return
    }
    const card = cardForAccount(accountId)
    selectedCardId.value = card && typeof card.id === 'number' ? card.id : null
    selectedCard.value = {
      id: card && typeof card.id === 'number' ? card.id : null,
      account_id: acc.id,
      account_name: acc.account_name,
      account_type: acc.account_type,
      card_type: card ? card.card_type : acc.account_type === 'credit' ? '信用卡' : '借记卡',
      masked_card_number: card ? card.masked_card_number : '',
    }
  }

  const selectedAccountId = computed(() =>
    selectedCard.value && Number.isInteger(selectedCard.value.account_id) ? selectedCard.value.account_id : null,
  )
  const selectedAccountType = computed(() => (selectedCard.value ? selectedCard.value.account_type : null))
  const isCreditSelected = computed(() => selectedAccountType.value === 'credit')

  return {
    selectedCardId,
    selectedCard,
    selectedAccountId,
    selectedAccountType,
    isCreditSelected,
    select,
    clear,
    selectAccountById,
    ensureAccounts,
    ensureCards,
    cardForAccount,
  }
}
