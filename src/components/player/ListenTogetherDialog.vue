<script setup lang="ts">
import { useListenTogetherStore } from "@/stores/listenTogether";
import { useCopyText } from "@/composables/useCopyText";

const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const store = useListenTogetherStore();
const { view } = storeToRefs(store);
const { copy } = useCopyText();
const invitation = ref("");

const headline = computed(() => {
  if (!view.value.inRoom) return t("player.listenTogether.idle");
  const count = view.value.members.length;
  return count > 0
    ? t("player.listenTogether.listening", { n: count })
    : t("player.listenTogether.listeningNow");
});

const memberLine = computed(() =>
  view.value.members
    .map((member) => member.displayName || member.id)
    .filter(Boolean)
    .join("、"),
);

const createRoom = (): void => {
  void store.create();
};

const joinRoom = (): void => {
  const value = invitation.value.trim();
  if (!value) return;
  void store.join(value);
};

const leaveRoom = (): void => {
  void store.leave();
};

const copyInvitation = (): void => {
  void copy(view.value.invitation);
};
</script>

<template>
  <SDialog v-model:open="open" :title="t('player.listenTogether.title')" width="420px">
    <div class="flex flex-col gap-4">
      <p class="text-center text-sm font-medium text-on-surface">{{ headline }}</p>
      <p v-if="view.inRoom && memberLine" class="text-center text-xs text-on-surface-variant">
        {{ memberLine }}
      </p>
      <div v-if="view.inRoom" class="flex flex-col gap-3">
        <div v-if="view.members.length" class="flex flex-col gap-2">
          <div v-for="member in view.members" :key="member.id" class="flex items-center gap-2">
            <img
              v-if="member.avatarUrl"
              :src="member.avatarUrl"
              alt=""
              class="size-8 rounded-full object-cover"
            />
            <span class="min-w-0 truncate text-sm">{{ member.displayName || member.id }}</span>
          </div>
        </div>
        <p class="break-all select-all text-xs text-on-surface-variant">{{ view.invitation }}</p>
        <div class="flex gap-2">
          <SButton
            class="flex-1"
            type="primary"
            :disabled="!view.invitation"
            @click="copyInvitation"
          >
            {{ t("player.listenTogether.copy") }}
          </SButton>
          <SButton
            class="flex-1"
            type="error"
            variant="secondary"
            :disabled="view.busy"
            @click="leaveRoom"
          >
            {{ t("player.listenTogether.leave") }}
          </SButton>
        </div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <p class="text-center text-xs text-on-surface-variant">
          {{ t("player.listenTogether.hint") }}
        </p>
        <SInput
          v-model="invitation"
          :placeholder="t('player.listenTogether.placeholder')"
          @keydown.enter="joinRoom"
        />
        <div class="flex gap-2">
          <SButton class="flex-1" type="primary" :disabled="view.busy" @click="createRoom">
            {{ t("player.listenTogether.create") }}
          </SButton>
          <SButton
            class="flex-1"
            variant="secondary"
            :disabled="view.busy || !invitation.trim()"
            @click="joinRoom"
          >
            {{ t("player.listenTogether.join") }}
          </SButton>
        </div>
      </div>
      <p v-if="view.error" class="break-all text-xs text-red-500">{{ view.error }}</p>
    </div>
  </SDialog>
</template>
