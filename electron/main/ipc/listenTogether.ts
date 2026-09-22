import { ipcMain } from "electron";
import {
  createListenTogether,
  getListenTogetherView,
  joinListenTogether,
  leaveListenTogether,
  replyListenTogether,
  startListenTogether,
} from "@main/services/listenTogether";
import type { ListenTogetherReply } from "@shared/types/listenTogether";

/** 注册一起听 IPC，并启动主进程同步循环 */
export const registerListenTogetherIpc = (): void => {
  startListenTogether();
  ipcMain.handle("listen-together:getView", () => getListenTogetherView());
  ipcMain.handle("listen-together:create", () => createListenTogether());
  ipcMain.handle("listen-together:join", (_event, invitation: string) =>
    joinListenTogether(invitation),
  );
  ipcMain.handle("listen-together:leave", () => leaveListenTogether());
  ipcMain.on("listen-together:reply", (_event, reply: ListenTogetherReply) => {
    replyListenTogether(reply);
  });
};
