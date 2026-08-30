<script setup>
import { computed, ref } from 'vue';
import { formatBytes } from '../api.js';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  maxFiles: { type: Number, default: 100 },
  maxRawBytes: { type: Number, default: 512 * 1024 * 1024 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'error']);
const input = ref(null);
const dragging = ref(false);
const totalBytes = computed(() => props.modelValue.reduce((sum, file) => sum + file.size, 0));

function keyFor(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function addFiles(fileList) {
  if (props.disabled) return;
  const current = [...props.modelValue];
  const existing = new Set(current.map(keyFor));
  for (const file of Array.from(fileList || [])) {
    if (current.length >= props.maxFiles) {
      emit('error', `附件数量不能超过 ${props.maxFiles}`);
      break;
    }
    const key = keyFor(file);
    if (!existing.has(key)) {
      current.push(file);
      existing.add(key);
    }
  }
  const bytes = current.reduce((sum, file) => sum + file.size, 0);
  if (input.value) input.value.value = '';
  if (bytes > props.maxRawBytes) {
    emit('error', `附件原始总大小不能超过 ${formatBytes(props.maxRawBytes)}`);
    return;
  }
  emit('update:modelValue', current);
}

function removeAt(index) {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit('update:modelValue', next);
}

function onDrop(event) {
  dragging.value = false;
  addFiles(event.dataTransfer?.files);
}
</script>

<template>
  <section class="file-picker" :class="{ dragging, disabled }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop">
    <input
      ref="input"
      class="visually-hidden"
      type="file"
      multiple
      :disabled="disabled"
      @change="addFiles($event.target.files)"
    />
    <button class="attachment-button" type="button" :disabled="disabled" @click="input?.click()">
      <span class="attachment-icon" aria-hidden="true">＋</span>
      <span>
        <strong>添加附件</strong>
        <small>支持任意文件类型，手机可直接打开系统文件选择器</small>
      </span>
    </button>

    <div v-if="modelValue.length" class="file-summary">
      <span>{{ modelValue.length }} 个文件</span>
      <span>{{ formatBytes(totalBytes) }} 原始大小</span>
      <button type="button" :disabled="disabled" @click="emit('update:modelValue', [])">清空</button>
    </div>

    <ul v-if="modelValue.length" class="file-list" aria-label="已选附件">
      <li v-for="(file, index) in modelValue" :key="keyFor(file)">
        <span class="file-type" aria-hidden="true">FILE</span>
        <span class="file-meta">
          <strong :title="file.name">{{ file.name }}</strong>
          <small>{{ formatBytes(file.size) }} · {{ file.type || '未知类型' }}</small>
        </span>
        <button class="remove-file" type="button" :aria-label="`移除 ${file.name}`" :disabled="disabled" @click="removeAt(index)">×</button>
      </li>
    </ul>
  </section>
</template>
