import type { ListenTogetherView } from "@shared/types/listenTogether";
import i18n from "@/i18n";
import { toast } from "@/composables/useToast";

const EMPTY_VIEW: ListenTogetherView = {
  inRoom: false,
  roomId: "",
  members: [],
  invitation: "",
  error: "",
  busy: false,
};

/** 一起听房间视图。协议在主进程，这里只镜像界面状态 */
export const useListenTogetherStore = defineStore("listenTogether", () => {
  const view = ref<ListenTogetherView>({ ...EMPTY_VIEW });
  const open = ref(false);

  const apply = (next: ListenTogetherView): void => {
    view.value = next;
  };

  // 应用级单例：房间视图和提示随进程存活，不在组件卸载时解绑
  window.api.listenTogether.onView(apply);
  window.api.listenTogether.onToast((code) => {
    toast.success(i18n.global.t(`player.listenTogether.toast.${code}`));
  });
  void window.api.listenTogether
    .getView()
    .then(apply)
    .catch(() => {});

  const create = async (): Promise<void> => {
    view.value = await window.api.listenTogether.create();
  };

  const join = async (invitation: string): Promise<void> => {
    view.value = await window.api.listenTogether.join(invitation);
  };

  const leave = async (): Promise<void> => {
    view.value = await window.api.listenTogether.leave();
  };

  return { view, open, create, join, leave };
});
