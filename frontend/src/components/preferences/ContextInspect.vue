<!--
上下文检查器面板：只读，展示当前会话的上下文装配快照。
包含：system 分段统计 + 全文折叠展开 / 工具表 / 消息尾部统计 / 估算 vs 实测并排。
无保存按钮，刷新按钮重新拉取快照。
调用示例：<ContextInspect :draft="draft" />
-->
<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { store, activeSession } from '../../store.js'
import { AgentAPI } from '../../utils/api.js'
import SettingsList from '../../ui/SettingsList.vue'
import SettingsRow from '../../ui/SettingsRow.vue'
import Button from '../../ui/Button.vue'
import Icon from '../../ui/Icon.vue'

defineProps({ draft: { type: Object, required: true } })

const data = ref(null)
const loading = ref(false)
const error = ref(null)
const systemExpanded = ref(false)
const toolsExpanded = ref(false)

const sessionId = computed(() => activeSession.value?.id || store.ui.activeSessionID || null)
const hasSession = computed(() => !!sessionId.value)

async function load() {
  if (!sessionId.value) { error.value = '请先打开一条会话，再查看其上下文详情。'; return }
  loading.value = true
  error.value = null
  try {
    data.value = await AgentAPI.contextInspect(sessionId.value)
  } catch (err) {
    error.value = err?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
// 切换会话时自动刷新
watch(sessionId, load)

// --- 格式化 ---
const fmtBytes = bytes => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const fmtChars = chars => chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字符` : `${chars} 字符`

const kindLabel = {
  prompt: '用户提示词',
  rules: '项目规则 (AGENTS.md)',
  'compact-guide': '压缩输出规范',
}

const pct = val => val != null ? `${val.toFixed ? val.toFixed(1) : val}%` : '—'
const num = val => val != null ? String(Math.round(val)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—'
</script>

<template>
  <section class="context-inspect" aria-label="上下文检查器">
    <!-- 顶栏 -->
    <div class="context-inspect__topbar">
      <span v-if="!hasSession" class="context-inspect__hint">请先打开一条会话</span>
      <span v-else-if="data" class="context-inspect__hint mono">{{ data.sessionId }}</span>
      <Button v-if="hasSession" icon :disabled="loading" title="刷新" @click="load" aria-label="刷新">
        <Icon name="refresh" :size="16" :class="{ 'spin': loading }" />
      </Button>
    </div>

    <!-- 错误 -->
    <div v-if="error" class="context-inspect__error">{{ error }}</div>

    <!-- 加载中骨架 -->
    <div v-else-if="loading && !data" class="context-inspect__loading">正在加载…</div>

    <template v-else-if="data">
      <!-- System 分段 -->
      <SettingsList title="System 提示词">
        <SettingsRow
          v-for="seg in data.system.segments" :key="seg.kind"
          :title="kindLabel[seg.kind] || seg.kind"
          :description="`第 ${seg.lineStart}–${seg.lineEnd} 行 · ${fmtChars(seg.chars)}`"
        />
        <SettingsRow title="总字符数" :description="`${fmtChars(data.system.length)}`">
          <Button variant="plain" size="small" @click="systemExpanded = !systemExpanded">
            {{ systemExpanded ? '收起' : '展开全文' }}
          </Button>
        </SettingsRow>
        <div v-if="systemExpanded" class="context-inspect__pre-wrap">{{ data.system.text }}</div>
      </SettingsList>

      <!-- 工具表 -->
      <SettingsList :title="`工具 (${data.tools.length})`">
        <SettingsRow title="" description="">
          <Button variant="plain" size="small" @click="toolsExpanded = !toolsExpanded">
            {{ toolsExpanded ? '收起工具列表' : '展开工具列表' }}
          </Button>
        </SettingsRow>
        <template v-if="toolsExpanded">
          <SettingsRow
            v-for="tool in data.tools" :key="tool.name"
            :title="tool.name"
            :description="tool.description || '无描述'"
          >
            <span class="context-inspect__badge" :class="`context-inspect__badge--${tool.permission}`">{{ tool.permission }}</span>
          </SettingsRow>
        </template>
      </SettingsList>

      <!-- 消息统计 -->
      <SettingsList :title="`消息 (${data.messages.total} 条)`">
        <SettingsRow title="总消息数" :description="`${data.messages.total} 条，展示尾部 ${data.messages.shown} 条`" />
        <template v-for="item in data.messages.items" :key="item.messageId">
          <SettingsRow
            :title="item.compact ? `[摘要] ${item.role}` : item.role"
            :description="`${fmtBytes(item.bytes)}${item.compact ? ' · 压缩摘要' : ''}`"
          />
        </template>
      </SettingsList>

      <!-- 估算 vs 实测 -->
      <SettingsList title="Token 用量">
        <SettingsRow title="上下文预算 (maxContextTokens)" :description="num(data.estimate.budget)" />
        <SettingsRow title="压缩阈值" :description="pct(data.estimate.compactThreshold * 100)" />
        <SettingsRow title="压缩触发点" :description="`${num(data.estimate.compactAt)} tokens`" />
        <SettingsRow title="静态估算 (agent-core)" :description="`${num(data.estimate.tokens)} tokens · ${pct(data.estimate.percentOfBudget)} 预算`" />
        <template v-if="data.actual">
          <SettingsRow title="实测值 (上一轮 onInject)" :description="`${num(data.actual.tokens)} tokens · ${pct(data.actual.percentOfBudget)} 预算`" />
          <SettingsRow
            title="估算 vs 实测差值"
            :description="`${num(Math.abs(data.estimate.tokens - data.actual.tokens))} tokens (${data.estimate.tokens >= data.actual.tokens ? '高估' : '低估'})`"
          />
        </template>
        <SettingsRow v-else title="实测值" description="尚无数据（该会话本次重启后未发过消息）" />
      </SettingsList>

      <!-- 压缩保留配置 -->
      <SettingsList title="当前压缩保留配置 (contextKeep)">
        <SettingsRow title="开场保留轮数" :description="`${data.keep.firstTurns} 轮`" />
        <SettingsRow title="最近保留轮数" :description="`${data.keep.recentTurns} 轮`" />
        <SettingsRow title="开场预算" :description="pct(data.keep.firstShare * 100)" />
        <SettingsRow title="最近预算" :description="pct(data.keep.recentShare * 100)" />
      </SettingsList>
    </template>
  </section>
</template>

<style scoped lang="scss">
.context-inspect {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px;
  }

  &__hint {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &.mono { font-family: var(--font-mono); }
  }

  &__error {
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--color-error-bg, #fee);
    color: var(--color-error, #c00);
    font-size: 13px;
  }

  &__loading {
    padding: 12px 16px;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  &__pre-wrap {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    padding: 12px 16px;
    background: var(--color-bg-code, var(--color-bg-secondary));
    border-radius: 0 0 8px 8px;
    max-height: 400px;
    overflow-y: auto;
    color: var(--color-text-secondary);
  }

  &__badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;

    &--allow { background: var(--color-success-bg, #e6f7ee); color: var(--color-success, #1a7a40); }
    &--ask   { background: var(--color-warning-bg, #fff7e6); color: var(--color-warning, #b46000); }
    &--deny  { background: var(--color-error-bg, #fee); color: var(--color-error, #c00); }
    &--review { background: var(--color-info-bg, #e6f0ff); color: var(--color-info, #2060c0); }
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.spin { animation: spin 1s linear infinite; }
</style>
