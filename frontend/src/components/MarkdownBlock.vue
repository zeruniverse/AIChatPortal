<script setup>
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps({ content: { type: String, default: '' } });
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer nofollow');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const rendered = computed(() => md.render(props.content || ''));
</script>

<template>
  <div class="markdown-body" v-html="rendered"></div>
</template>
