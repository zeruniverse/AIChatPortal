<script setup>
defineProps({ status: { type: String, required: true } });
const labels = {
  uploading: '上传中', queued: '等待处理', preparing: '压缩附件', running: '生成中', completed: '已完成', failed: '失败',
};
</script>
<template>
  <span class="status-pill" :class="`status-${status}`"><span class="status-dot" aria-hidden="true"></span>{{ labels[status] || status }}</span>
</template>
