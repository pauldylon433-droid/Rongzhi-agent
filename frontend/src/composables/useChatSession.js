import { ref } from 'vue'
import { chatAssistant, fetchCurrentChat, fetchConversations, selectConversation, newConversation } from '../api/index.js'
import { useDataRefresh } from './useDataRefresh.js'
import { useTransferSignal } from './useTransferSignal.js'
import { useCardOpSignal } from './useCardOpSignal.js'
import { useSubscriptionOpSignal } from './useSubscriptionOpSignal.js'
import { useRepaymentSignal } from './useRepaymentSignal.js'
import { useCardSelection } from './useCardSelection.js'
import { useTasksSignal } from './useTasksSignal.js'

// 会话状态单例：总览右侧助手与「AI 助手」工作区共用同一份会话状态。
// 切换视图、展开 / 收起助手时保留当前对话、输入草稿、请求状态与未完成任务；
// 状态在模块级，避免重复挂载造成重复请求或消息丢失。

const messages = ref([])
const input = ref('')
const sending = ref(false)
const sendingSessionId = ref(null) // 正在生成回复的会话（null 表示空白新会话）；用于区分「正在思考」与「另一会话正在生成回复」
const sessionId = ref(null)
const composing = ref(false)
const loading = ref(true)
const loadError = ref('')
const loaded = ref(false) // 是否已从服务端恢复过当前对话（切换视图不重复拉取）
const lastActiveAt = ref('') // 当前会话最近活动时间（后端未暴露对话级时间戳，以前端最后加载/发送为准）
const conversations = ref([]) // 会话历史列表（最近对话，与当前会话共享；总览侧栏与工作区共用）
const conversationsLoading = ref(false)

const { refresh } = useDataRefresh()
const { notifyChange: notifyTransferChange } = useTransferSignal()
const { notifyChange: notifyCardOpChange } = useCardOpSignal()
const { notifyChange: notifySubscriptionOpChange } = useSubscriptionOpSignal()
const { notifyChange: notifyRepaymentChange } = useRepaymentSignal()
const { selectedCardId } = useCardSelection()
const { bump: bumpTasks } = useTasksSignal()

let seq = 0
function nextId() {
  seq += 1
  return seq
}

// 会话视图版本：每次切换 / 新建 / 恢复当前会话时递增，用于丢弃等待期间到达的旧会话延迟响应，
// 避免旧会话回复串入新会话或新消息串入其他会话。
let sessionEpoch = 0

// 导航串行队列：打开 / 新建会话依次执行，保证服务端「当前会话指针」按用户最后操作顺序写入，
// 避免快速 A→B→新对话 / A→B→A 时较早返回的请求覆盖最后一次选择。
let navQueue = Promise.resolve()
function enqueueNav(task) {
  const run = navQueue.then(task, task)
  navQueue = run.catch(() => {})
  return run
}

// 组件挂载时注册滚动 / 聚焦回调（同一时刻仅一个聊天面板挂载）
let scrollToBottom = () => {}
let focusInput = () => {}

export function useChatSession() {
  function registerHooks(hooks) {
    if (hooks && hooks.scrollToBottom) scrollToBottom = hooks.scrollToBottom
    if (hooks && hooks.focusInput) focusInput = hooks.focusInput
  }

  async function send(text) {
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value || sending.value) return

    // 捕获本次消息归属的会话（首条消息时为 null，由后端新建会话）；并记录当前视图版本，
    // 用于等待期间切换会话时丢弃迟到的响应，避免串会话。
    const targetSessionId = sessionId.value
    const epoch = sessionEpoch

    // 乐观显示的本条用户消息；若服务端判定为疑似凭据并拦截，将整条移除，避免错误提示再次回显原文。
    const optimistic = { id: nextId(), role: 'user', text: value, toolRecords: [], incomplete: false, error: '' }
    messages.value.push(optimistic)
    lastActiveAt.value = new Date().toISOString()
    input.value = ''
    sending.value = true
    sendingSessionId.value = targetSessionId
    focusInput() // 发送后立即聚焦，便于边等待边继续输入
    scrollToBottom()

    try {
      const data = await chatAssistant({ message: value, sessionId: targetSessionId, selectedCardId: selectedCardId.value })

      // 延迟响应防护：等待期间已切换 / 新建 / 恢复会话，则该响应属于原会话，不写入当前列表。
      // 原会话结果已由服务端持久化，重开该会话即可看到，不丢消息。
      if (sessionEpoch !== epoch) {
        loadConversations() // 原会话标题 / 时间已更新，刷新历史列表
        return
      }

      if (targetSessionId === null) {
        sessionId.value = data.sessionId || sessionId.value
        sendingSessionId.value = sessionId.value
      }
      messages.value.push({
        id: nextId(),
        role: 'assistant',
        text: data.reply || '',
        toolRecords: data.toolRecords || [],
        incomplete: !!data.incomplete,
        error: '',
      })
      // 改单：通知旧待确认单的已显示卡片回读最新状态（无需手动刷新即显示「已取消」）
      for (const rec of data.toolRecords || []) {
        if (rec.name === 'prepare_transfer' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
          notifyTransferChange(rec.data.previous.ref_no)
        }
        if (rec.name === 'prepare_card_operation' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
          notifyCardOpChange(rec.data.previous.ref_no)
        }
        if (rec.name === 'prepare_subscription_operation' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
          notifySubscriptionOpChange(rec.data.previous.ref_no)
        }
        if (rec.name === 'prepare_repayment' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
          notifyRepaymentChange(rec.data.previous.ref_no)
        }
        if (rec.name === 'start_subscription_review') {
          bumpTasks() // 模型启动了跨场景任务：通知任务区刷新
        }
      }
      loadConversations() // 当前会话标题 / 时间已更新
    } catch (e) {
      if (sessionEpoch === epoch) {
        // 疑似凭据消息已被服务端拦截且未发送给模型 / 未持久化：从界面移除乐观消息，避免回显原文
        if (e && e.code === 'credential_detected') {
          const idx = messages.value.indexOf(optimistic)
          if (idx >= 0) messages.value.splice(idx, 1)
        }
        messages.value.push({
          id: nextId(),
          role: 'assistant',
          text: '',
          toolRecords: [],
          incomplete: false,
          error: e && e.message ? e.message : '请求失败',
        })
      }
    } finally {
      sending.value = false
      sendingSessionId.value = null
      scrollToBottom()
    }
  }

  function newChat() {
    if (sending.value) return Promise.resolve()
    return enqueueNav(async () => {
      const epoch = ++sessionEpoch
      messages.value = []
      sessionId.value = null
      input.value = ''
      loadError.value = ''
      loading.value = false
      try {
        await newConversation()
      } catch {
        // 服务端切换失败不阻塞本地清空；下次发送会新建会话
      }
      if (epoch !== sessionEpoch) return // 已被后续导航取代
      loadConversations() // 旧会话保留在历史列表
      focusInput()
    })
  }

  async function loadCurrent() {
    loading.value = true
    loadError.value = ''
    const epoch = ++sessionEpoch
    try {
      const data = await fetchCurrentChat()
      if (epoch !== sessionEpoch) return // 已被后续导航取代
      sessionId.value = data.sessionId || null
      messages.value = (data.messages || []).map((m) => ({
        id: nextId(),
        role: m.role,
        text: m.text || '',
        toolRecords: m.toolRecords || [],
        incomplete: !!m.incomplete,
        error: m.error || '',
      }))
      lastActiveAt.value = new Date().toISOString()
    } catch (e) {
      if (epoch !== sessionEpoch) return
      loadError.value = e && e.message ? e.message : '加载聊天记录失败'
    } finally {
      loaded.value = true
      if (epoch === sessionEpoch) {
        loading.value = false
        scrollToBottom({ force: true }) // 加载 / 恢复会话：定位到最后一条
      }
    }
    loadConversations() // 同步刷新会话历史列表
  }

  // 会话历史列表：从后端读取当前用户全部会话（只读），失败保留原列表不阻塞聊天。
  async function loadConversations() {
    conversationsLoading.value = true
    try {
      conversations.value = (await fetchConversations()) || []
    } catch {
      // 列表加载失败不阻塞聊天
    } finally {
      conversationsLoading.value = false
    }
  }

  // 打开历史会话：切换当前对话并恢复其消息与结果卡（不重发消息、不调用模型）。
  function openConversation(id) {
    if (typeof id !== 'string' || !id) return Promise.resolve()
    return enqueueNav(async () => {
      const epoch = ++sessionEpoch // 立即作废等待中的旧会话响应
      loading.value = true
      loadError.value = ''
      try {
        const view = await selectConversation(id)
        if (epoch !== sessionEpoch) return // 已被后续导航取代
        sessionId.value = view.sessionId || null
        messages.value = (view.messages || []).map((m) => ({
          id: nextId(),
          role: m.role,
          text: m.text || '',
          toolRecords: m.toolRecords || [],
          incomplete: !!m.incomplete,
          error: m.error || '',
        }))
        lastActiveAt.value = new Date().toISOString()
        loadConversations() // 列表顺序 / 最近活跃时间已变化
      } catch (e) {
        if (epoch !== sessionEpoch) return
        loadError.value = e && e.message ? e.message : '打开会话失败'
      } finally {
        if (epoch === sessionEpoch) {
          loading.value = false
          scrollToBottom({ force: true }) // 切换会话：定位到最后一条
        }
      }
    })
  }

  // 首次挂载时恢复一次；重试按钮显式调用 loadCurrent
  function ensureLoaded() {
    if (loaded.value) return
    loadCurrent()
  }

  return {
    messages,
    input,
    sending,
    sendingSessionId,
    sessionId,
    composing,
    loading,
    loadError,
    lastActiveAt,
    conversations,
    conversationsLoading,
    send,
    newChat,
    loadCurrent,
    loadConversations,
    openConversation,
    ensureLoaded,
    registerHooks,
  }
}
