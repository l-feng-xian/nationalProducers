<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { findPreset } from '@/services/vector/presets'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import DepthPreview from '@/components/settings/DepthPreview.vue'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

/** 模板里要显示字面的 {{user}}，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const USER_MACRO = '{{user}}'

const wi = computed(() => settings.settings.worldInfo)
const mem = computed(() => settings.settings.memory)
/** 非 null 即「已下载且已勾选启用」。向量召回的参数只在这时才有意义 */
const activeModel = computed(() => findPreset(mem.value.vector.modelId))
const budgetTokens = computed(() => {
  const cap = wi.value.world_info_budget_cap
  const raw = Math.round(
    (wi.value.world_info_budget * settings.settings.provider.contextWindow) / 100,
  )
  return cap > 0 ? Math.min(raw, cap) : raw
})

onMounted(async () => {
  if (!settings.loaded) await settings.load()
})
</script>

<template>
  <AppTopbar title="设置" />
  <div class="cbx-scroll body">
    <div class="cbx-form-col">
      <!-- ② 提示词与深度（需求 4） -->
      <section class="cbx-card sec">
        <h3>提示词与插入深度</h3>
        <p class="note">
          <strong>深度语义</strong>：depth N = 注入之后仍有 N 条真实消息；
          <strong>depth 0 = 追加到历史最末，作为独立的一条消息</strong
          >（离模型生成最近，约束力最强）。
        </p>

        <label class="cbx-field">
          <span class="cbx-field__label">主系统提示词</span>
          <textarea
            v-model="settings.settings.prompt.mainPrompt"
            class="cbx-textarea"
            rows="3"
            @change="settings.touch()"
          />
        </label>

        <div v-for="mode in ['solo', 'group'] as const" :key="mode" class="cbx-collapse cons">
          <div class="cbx-collapse__head">
            {{ mode === 'solo' ? '1v1 约束提示词' : '1vN 约束提示词' }}
            <label class="cbx-switch">
              <input
                v-model="settings.settings.constraint[mode].enabled"
                type="checkbox"
                @change="settings.touch()"
              />
              <span class="cbx-switch__track" />
            </label>
          </div>
          <div class="cbx-collapse__body">
            <textarea
              v-model="settings.settings.constraint[mode].text"
              class="cbx-textarea"
              rows="4"
              @change="settings.touch()"
            />
            <div class="grid2 mt">
              <label class="cbx-field">
                <span class="cbx-field__label">插入深度</span>
                <input
                  v-model.number="settings.settings.constraint[mode].depth"
                  class="cbx-input"
                  type="number"
                  min="0"
                  @change="settings.touch()"
                />
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">角色</span>
                <select
                  v-model.number="settings.settings.constraint[mode].role"
                  class="cbx-input"
                  @change="settings.touch()"
                >
                  <option :value="0">system</option>
                  <option :value="1">user</option>
                  <option :value="2">assistant</option>
                </select>
              </label>
            </div>
            <!-- 深度可视化是「图示」不是控件：移出 <label> 后不再误触发聚焦，
                 也不再把左格撑高、让右格下半空一片 -->
            <DepthPreview class="depth-preview" :depth="settings.settings.constraint[mode].depth" />
          </div>
        </div>
      </section>

      <!-- ③ 用户身份 -->
      <section class="cbx-card sec">
        <h3>用户身份</h3>
        <label class="cbx-field cbx-field--sm">
          <span class="cbx-field__label">你的名字（即 {{ USER_MACRO }} 的值）</span>
          <input
            v-model="settings.settings.persona.name"
            class="cbx-input"
            @change="settings.touch()"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">人设描述</span>
          <textarea
            v-model="settings.settings.persona.description"
            class="cbx-textarea"
            rows="3"
            @change="settings.touch()"
          />
        </label>
      </section>

      <!-- ④ 世界书全局参数 -->
      <section class="cbx-card sec">
        <h3>世界书</h3>
        <p class="note">
          这些是**全局**扫描参数，对所有世界书生效；单条条目里留「继承全局」的字段就用这里的值。
          具体哪几本书全局启用，在「世界书」页面用书名右侧的徽标切换。
        </p>
        <div class="grid2">
          <label class="cbx-field">
            <span class="cbx-field__label">扫描深度（往回看几条消息）</span>
            <input
              v-model.number="wi.world_info_depth"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">预算（占上下文 %）</span>
            <input
              v-model.number="wi.world_info_budget"
              class="cbx-input"
              type="number"
              min="1"
              max="100"
              @change="settings.touch()"
            />
            <span class="cbx-field__hint">约 {{ budgetTokens }} tok</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">预算硬上限（0 = 不限）</span>
            <input
              v-model.number="wi.world_info_budget_cap"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">插入策略</span>
            <select
              v-model.number="wi.world_info_character_strategy"
              class="cbx-input"
              @change="settings.touch()"
            >
              <option :value="0">均匀混排</option>
              <option :value="1">角色书优先</option>
              <option :value="2">全局书优先</option>
            </select>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">最少激活条数（0 = 不强制）</span>
            <input
              v-model.number="wi.world_info_min_activations"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
            <span class="cbx-field__hint">不足时自动扩大扫描窗口</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">最大递归轮数（0 = 不限）</span>
            <input
              v-model.number="wi.world_info_max_recursion_steps"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
        </div>

        <div class="switches">
          <label class="sw">
            <input v-model="wi.world_info_recursive" type="checkbox" @change="settings.touch()" />
            <span>递归激活（条目内容可再触发别的条目）</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_include_names"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>扫描时带上发言者名字</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_case_sensitive"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>区分大小写</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_match_whole_words"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>整词匹配</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_use_group_scoring"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>包含组内按命中数评分</span>
          </label>
        </div>
      </section>

      <!-- ⑤ 会话记忆 -->
      <section class="cbx-card sec">
        <h3>会话记忆</h3>
        <p class="note">
          每积累若干条消息，让模型把这段对话**整体重写**成一段简短的「此刻状态」，
          注入到每轮提示词里。它描述的是现在时的关系、处境与未了结的事，
          每次重写都会丢掉不再成立的内容 —— 这是它与「把旧消息捞回来」的根本区别。
          <strong>会产生额外的 API 调用</strong>，默认关闭。
        </p>

        <div class="switchrow">
          <label class="cbx-switch swopt">
            <input v-model="mem.enabled" type="checkbox" @change="settings.touch()" />
            <span class="cbx-switch__track" />
            <span>启用会话记忆</span>
          </label>
        </div>

        <template v-if="mem.enabled">
          <div class="grid2">
            <label class="cbx-field">
              <span class="cbx-field__label">每多少条消息提炼一次</span>
              <input
                v-model.number="mem.intervalMessages"
                class="cbx-input"
                type="number"
                min="2"
                max="50"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">新对话字符下限</span>
              <input
                v-model.number="mem.minNewChars"
                class="cbx-input"
                type="number"
                min="0"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">喂给提炼的字符上限</span>
              <input
                v-model.number="mem.dialogueCharLimit"
                class="cbx-input"
                type="number"
                min="500"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">注入深度</span>
              <input
                v-model.number="mem.depth"
                class="cbx-input"
                type="number"
                min="0"
                @change="settings.touch()"
              />
            </label>
          </div>

          <div class="cbx-divider" />
          <div class="vecrow">
            <span class="cbx-field__label">向量召回</span>
            <span v-if="activeModel" class="cbx-badge cbx-badge--success">
              已启用 · {{ activeModel.name }}
            </span>
            <span v-else class="cbx-badge">未启用</span>
            <RouterLink to="/models" class="cbx-btn cbx-btn--soft vecrow__go">模型管理</RouterLink>
          </div>
          <p class="note">
            把早期对话按<strong>语义</strong>召回 —— 你说「那把断了的刀」也能找到「缺口长刀」。
            模型在本机浏览器里跑，推理全程离线、不上传任何内容；但模型本身需要先到
            <RouterLink to="/models">模型管理</RouterLink>
            手动下载一次并勾选启用。没有勾选的模型不会产生任何流量。 它<strong
              >无法表达「已经不成立」</strong
            >
            —— 那由上面的状态卡负责。
          </p>
          <div v-if="activeModel" class="grid2">
            <label class="cbx-field">
              <span class="cbx-field__label">召回条数</span>
              <input
                v-model.number="mem.vector.topK"
                class="cbx-input"
                type="number"
                min="1"
                max="8"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">相似度下限</span>
              <input
                v-model.number="mem.vector.minScore"
                class="cbx-input"
                type="number"
                step="0.05"
                min="0"
                max="1"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">召回注入深度</span>
              <input
                v-model.number="mem.vector.recallDepth"
                class="cbx-input"
                type="number"
                min="0"
                @change="settings.touch()"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">首次回填条数</span>
              <input
                v-model.number="mem.vector.backfillLimit"
                class="cbx-input"
                type="number"
                min="50"
                @change="settings.touch()"
              />
            </label>
          </div>

          <label class="cbx-field cbx-field--md">
            <span class="cbx-field__label">提炼专用模型（留空 = 用主对话模型）</span>
            <input
              v-model="mem.model"
              class="cbx-input"
              :placeholder="settings.settings.provider.model || 'deepseek-chat'"
              @change="settings.touch()"
            />
            <span class="cbx-field__hint">
              主聊用推理模型时，把提炼切到普通模型能省一半以上成本
            </span>
          </label>
        </template>
      </section>

      <!-- ⑥ 外观 -->
      <section class="cbx-card sec">
        <h3>外观与聊天</h3>
        <div class="switchrow">
          <label class="cbx-switch swopt">
            <input
              v-model="settings.settings.chat.sendOnEnter"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
            <span>回车发送（移动端始终换行）</span>
          </label>
          <label class="cbx-switch swopt">
            <input
              v-model="settings.settings.chat.showTokens"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
            <span>顶栏显示 token 计数</span>
          </label>
        </div>
        <label class="cbx-field fontrow">
          <span class="cbx-field__label">
            消息字体大小 · {{ settings.settings.chat.messageFontSize }}px
          </span>
          <input
            v-model.number="settings.settings.chat.messageFontSize"
            type="range"
            class="fontrow__range"
            min="10"
            max="30"
            step="1"
            aria-label="消息字体大小"
            @input="settings.touch()"
          />
          <span class="cbx-field__hint">调整对话消息正文的字号（10–30px），拖动立即生效。</span>
        </label>
      </section>

      <!-- ⑥ 数据（整节已移至「数据管理」页）-->
      <section class="cbx-card sec">
        <h3>数据</h3>
        <p class="note">
          备份导出/导入，以及按会话管理变量、状态卡、向量索引等关联数据， 都在
          <RouterLink to="/data">数据管理</RouterLink> 里。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
/* 原 .wrap 规则已整条删除：宽度/对齐/字段上限统一由 base.css 的
   .cbx-form-col 提供（max-width: var(--cbx-form-w) + 左对齐）。
   关键一步是去掉 margin: 0 auto —— 居中时卡片左缘 506 与 AppTopbar
   标题左缘 260 差 246px；左对齐后两者都等于 240(sidebar) + 20(.body padding) = 260。
   移动端两边同为 space-3(12px)，同样严格对齐。 */
.sec {
  margin-bottom: var(--cbx-space-4);
}
.sec h3 {
  margin-bottom: var(--cbx-space-3);
}
.vecrow {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  flex-wrap: wrap;
}
.vecrow__go {
  margin-left: auto;
  text-decoration: none;
}

.note {
  /* 说明性散文是全页唯一真正需要「阅读宽」的内容 —— 卡片加宽到 1280 后
     必须显式封顶，否则 1238px 的行长完全不可读。 */
  max-width: var(--cbx-read-w);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  margin-bottom: var(--cbx-space-4);
  line-height: 1.6;
}
.note code {
  font-family: var(--cbx-font-mono);
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-code-bg);
}
.switches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3) var(--cbx-space-5);
  margin-top: var(--cbx-space-3);
}
.sw {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  cursor: pointer;
}
/* 字段收窄之后，多出来的横向空间要变成「更多列 / 更少行」，
   否则只是把空白从卡片外挪进卡片内。
   ⚠ 用 auto-fill 不用 auto-fit：auto-fit 会折叠空轨道，让只有 2 个字段的
     网格把两格各拉到约 400px。
   260px 下限按最长 label「扫描深度（往回看几条消息）」量的，保证不换行。 */
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--cbx-space-3);
}
/* 开关行：布尔值的「内容宽度」就是 40×22 的 track + 一行字 */
.switchrow {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3) var(--cbx-space-6);
  margin-bottom: var(--cbx-space-4);
}
.switchrow:last-child {
  margin-bottom: 0;
}
/* 与 .cbx-switch 同挂一个 <label>：单层 label，点文字也能切换（HTML 合法）。
   <768px 时 base.css 的 .cbx-switch{min-height:44px} 会顶起整行。 */
.swopt {
  gap: var(--cbx-space-3);
  min-height: 36px;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
}
/* 消息字号滑块：原生 range + 主题色轨道，宽度占满卡片 */
.fontrow {
  display: block;
}
.fontrow__range {
  width: 100%;
  margin: var(--cbx-space-2) 0 var(--cbx-space-1);
  accent-color: var(--cbx-brand);
  cursor: pointer;
}
/* 深度可视化是「图示」不是控件，给它内容宽度上限，
   别让它在 1238px 的卡片里被拉成一条空条 */
.depth-preview {
  max-width: var(--cbx-fieldw-md);
}
.mt {
  margin-top: var(--cbx-space-3);
}
.cons {
  margin-top: var(--cbx-space-4);
}
.cons .cbx-collapse__head {
  cursor: default;
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .grid2 {
    /* auto-fill 在 317px 卡片里本就只有 1 列，这里显式声明是为了
       符合设计规范「内容多列网格在移动端降为单列」 */
    grid-template-columns: 1fr;
  }
  /* ⚠ 必须显式写：base.css 移动端块里的 .cbx-switch{min-height:44px} 是 (0,1,0)，
     压不过本文件 scoped 后变成 (0,2,0) 的 .swopt，会把开关按在 36px。
     桌面完全正常，只有手机上触控区不达标 —— 实测抓到的。 */
  .swopt {
    min-height: var(--cbx-tap-min);
  }
  /* 世界书那 5 个裸 checkbox 从来没被放大过（约 13px），补足 44px 触控区 */
  .sw {
    min-height: var(--cbx-tap-min);
  }
  .sw input[type='checkbox'] {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
}
</style>
