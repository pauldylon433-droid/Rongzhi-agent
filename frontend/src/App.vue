<script setup>
// 应用外壳：CSS Grid 三栏（导航 / 业务主区 / 总览右侧 AI），比例相对整个应用宽度。
// 总览展开态 = 14 : 56.5 : 29.5；其余视图（AI 工作区、各业务页）与总览「收起 AI」时退化为导航 + 主区。
import { ref, computed, onMounted } from 'vue'
import { useNavigation } from './composables/useNavigation.js'
import { useAssistantState } from './composables/useAssistantState.js'
import NavSidebar from './components/NavSidebar.vue'
import AssistantSidebar from './components/AssistantSidebar.vue'
import BrandMark from './components/BrandMark.vue'
import OverviewView from './views/OverviewView.vue'
import AssistantView from './views/AssistantView.vue'
import AccountsView from './views/AccountsView.vue'
import BillView from './views/BillView.vue'
import CardsView from './views/CardsView.vue'
import SubscriptionsView from './views/SubscriptionsView.vue'
import PlansView from './views/PlansView.vue'
import TasksView from './views/TasksView.vue'

const { currentView } = useNavigation()
const { open: assistantOpen, collapse: collapseAssistant } = useAssistantState()

const navCollapsed = ref(false)
const mobileNavOpen = ref(false)
const isCompactNav = ref(false) // 平板（768—1279px）导航自动收为图标栏

const effectiveNavCollapsed = computed(() => navCollapsed.value || isCompactNav.value)

function syncNavCompact() {
  if (typeof window === 'undefined') return
  const w = window.innerWidth
  isCompactNav.value = w >= 768 && w < 1280
}

const viewMap = {
  overview: OverviewView,
  assistant: AssistantView,
  accounts: AccountsView,
  bill: BillView,
  cards: CardsView,
  subscriptions: SubscriptionsView,
  plans: PlansView,
  tasks: TasksView,
}
const currentComponent = computed(() => viewMap[currentView.value] || OverviewView)

const isOverview = computed(() => currentView.value === 'overview')
// 仅总览显示第三栏（AI 助手）；其余视图占满主区
const aiVisible = computed(() => isOverview.value && assistantOpen.value)

// 三栏网格：展开态 14fr 56.5fr 29.5fr；收起 AI 或非总览视图退化为导航 + 主区
const gridColumns = computed(() => {
  const nav = effectiveNavCollapsed.value ? '64px' : '14fr'
  if (aiVisible.value) return `${nav} 56.5fr 29.5fr`
  return effectiveNavCollapsed.value ? '64px 1fr' : '14fr 86fr'
})

function toggleCollapse() {
  navCollapsed.value = !navCollapsed.value
}
function closeMobileNav() {
  mobileNavOpen.value = false
}

// 手机端 AI 侧栏默认收起（抽屉），桌面端默认展开
onMounted(() => {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
    collapseAssistant()
  }
  syncNavCompact()
  window.addEventListener('resize', syncNavCompact)
})
</script>

<template>
  <div class="app-shell" :style="{ gridTemplateColumns: gridColumns }">
    <NavSidebar
      :collapsed="effectiveNavCollapsed"
      :mobile-open="mobileNavOpen"
      @toggle-collapse="toggleCollapse"
      @navigate="closeMobileNav"
    />

    <div class="app-main">
      <header class="mobile-topbar">
        <button class="mobile-menu" aria-label="打开导航" @click="mobileNavOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div class="mobile-brand">
          <BrandMark :size="28" />
          <span class="mobile-brand-name">融智 Agent</span>
        </div>
        <span class="mobile-env">模拟银行环境</span>
      </header>

      <component :is="currentComponent" />
    </div>

    <AssistantSidebar v-if="aiVisible" :open="assistantOpen" @collapse="collapseAssistant" />

    <div v-if="mobileNavOpen" class="nav-backdrop" @click="closeMobileNav"></div>
    <div v-if="isOverview && assistantOpen" class="assistant-backdrop" @click="collapseAssistant"></div>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  height: 100vh;
  overflow: hidden;
  align-items: stretch;
}
.app-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
  overflow-y: auto;
}
.mobile-topbar {
  display: none;
}
.nav-backdrop {
  display: none;
}
.assistant-backdrop {
  display: none;
}

@media (max-width: 767px) {
  .app-shell {
    display: block;
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }
  .app-main {
    overflow: visible;
    min-height: 100vh;
  }
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--navy);
    color: #fff;
    position: sticky;
    top: 0;
    z-index: 40;
  }
  .mobile-menu {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    color: #fff;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }
  .mobile-menu svg {
    width: 20px;
    height: 20px;
  }
  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }
  .mobile-brand-name {
    font-size: 15px;
    font-weight: 600;
  }
  .mobile-env {
    font-size: 11px;
    color: #cbd5e1;
    background: rgba(255, 255, 255, 0.12);
    padding: 3px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .nav-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 45;
    background: rgba(15, 23, 42, 0.35);
  }
  .assistant-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 65;
    background: rgba(15, 23, 42, 0.35);
  }
}
</style>
