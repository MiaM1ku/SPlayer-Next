/** 一起听房间成员 */
export interface ListenTogetherMember {
  id: string;
  displayName: string;
  avatarUrl: string;
}

/** 一起听房间 */
export interface ListenTogetherRoom {
  id: string;
  creatorAccountId: string;
  members: ListenTogetherMember[];
}

/** 渲染层对话框使用的房间视图 */
export interface ListenTogetherView {
  inRoom: boolean;
  roomId: string;
  members: ListenTogetherMember[];
  /** 可粘贴给好友的邀请链接，未进房时为空 */
  invitation: string;
  error: string;
  busy: boolean;
}

/** 渲染层上报给同步循环的本地播放快照 */
export interface ListenTogetherSnapshot {
  /** 当前网易云歌曲 id；非网易云歌曲为空 */
  currentSongId: string;
  /**
   * 队列歌曲 id。
   * 仅当队列全部是网易云歌曲时有值，混有其它来源时为空，避免把本地文件报进房间。
   */
  queueSongIds: string[];
  positionMs: number;
  durationMs: number;
  playing: boolean;
  /** 正在切歌加载，这段时间的曲目变化不能当成用户操作上报 */
  transitioning: boolean;
  seekRevision: number;
  endRevision: number;
}

/** 主进程要求渲染层执行的播放动作 */
export type ListenTogetherCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; positionMs: number }
  | { type: "select"; songId: string; positionMs: number; playing: boolean }
  | { type: "next" }
  | {
      type: "replaceQueue";
      songIds: string[];
      currentSongId: string;
      positionMs: number;
      playing: boolean;
    }
  | { type: "blockAutoAdvance"; blocked: boolean };

/** 主进程向渲染层要快照或执行动作 */
export interface ListenTogetherRequest {
  id: number;
  kind: "snapshot" | "command";
  command?: ListenTogetherCommand;
}

/** 渲染层对一次请求的回复 */
export interface ListenTogetherReply {
  id: number;
  ok: boolean;
  data?: ListenTogetherSnapshot;
  error?: string;
}

/** 需要渲染层弹出的一次性提示 */
export type ListenTogetherToast =
  | "created"
  | "joined"
  | "left"
  | "restored"
  | "remoteProgress"
  | "remoteTrack"
  | "remotePlay"
  | "remotePause";

/** 渲染进程一起听 API（window.api.listenTogether） */
export interface ListenTogetherApi {
  /** 读取当前房间视图 */
  getView: () => Promise<ListenTogetherView>;
  /** 用当前网易云队列创建房间 */
  create: () => Promise<ListenTogetherView>;
  /** 加入邀请链接或房间 ID */
  join: (invitation: string) => Promise<ListenTogetherView>;
  /** 退出当前房间 */
  leave: () => Promise<ListenTogetherView>;
  /** 订阅房间视图。应用级单例订阅，随进程存活 */
  onView: (callback: (view: ListenTogetherView) => void) => () => void;
  /** 订阅一次性提示 */
  onToast: (callback: (toast: ListenTogetherToast) => void) => () => void;
  /** 订阅主进程的快照 / 播放请求。只应由播放桥接安装一次 */
  onRequest: (callback: (request: ListenTogetherRequest) => void) => () => void;
  /** 回复 onRequest */
  reply: (reply: ListenTogetherReply) => void;
}
