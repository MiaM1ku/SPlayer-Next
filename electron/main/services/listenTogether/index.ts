/**
 * 网易云一起听。
 *
 * 房间协议与同步策略来自 QPlayer 网易云插件：主进程每秒对齐一次本地播放和房间快照。
 * 定时器放在主进程，是因为主窗口开启了 backgroundThrottling，隐藏后渲染进程定时器会被挂起。
 * 队列和切歌仍由渲染进程执行，这里通过一次请求 / 回复把快照和动作送过去。
 */

import { callNetease, getNeteaseCookies } from "@main/apis/netease";
import { sendToMain } from "@main/utils/broadcast";
import { getLocale } from "@main/utils/i18n";
import { neteaseLog } from "@main/utils/logger";
import { getMainWindow } from "@main/window";
import type {
  ListenTogetherCommand,
  ListenTogetherReply,
  ListenTogetherRoom,
  ListenTogetherSnapshot,
  ListenTogetherToast,
  ListenTogetherView,
} from "@shared/types/listenTogether";
import {
  assertListenOk,
  commandSignature,
  idsSignature,
  isNewRemote,
  isRateLimited,
  parseInvitation,
  listenTogetherShareUrl,
  pickLeader,
  plain,
  rateLimitDelayMs,
  remotePlaybackTarget,
  roomFromResponse,
  snapshotFromResponse,
  statusFromResponse,
  type RemoteCommand,
  type RemoteSnapshot,
} from "./protocol";

interface LoginStatusBody {
  data?: { profile?: { userId?: unknown } };
}

const COPY = {
  "zh-CN": {
    needLogin: "请先登录后使用一起听",
    needQueue: "请先播放网易云歌曲，并保证当前队列都是网易云歌曲",
    empty: "请输入邀请链接或房间 ID",
    tooLong: "邀请内容过长",
    badEncoding: "邀请链接编码无效",
    wrongProvider: "这不是网易云一起听邀请",
    badRoomId: "邀请链接或房间 ID 格式无效",
    badInviter: "邀请者 ID 格式无效",
    rateLimitStop: "一起听同步请求过于频繁，请退出房间后重试",
    rateLimitWait: (seconds: number): string => `一起听请求受限，将在 ${seconds} 秒后重试`,
    notReady: "播放器还没准备好",
    createFailed: "创建一起听房间失败",
    joinFailed: "加入一起听房间失败",
    notInRoom: "当前没有一起听房间",
  },
  "en-US": {
    needLogin: "Sign in to listen together",
    needQueue: "Play a NetEase song and keep the queue NetEase-only",
    empty: "Enter an invitation link or room ID",
    tooLong: "Invitation is too long",
    badEncoding: "Invitation link encoding is invalid",
    wrongProvider: "This is not a NetEase Listen Together invitation",
    badRoomId: "Invitation link or room ID is invalid",
    badInviter: "Inviter ID is invalid",
    rateLimitStop: "Listen Together is being rate limited. Leave the room and try again",
    rateLimitWait: (seconds: number): string =>
      `Listen Together is rate limited. Retrying in ${seconds}s`,
    notReady: "The player is not ready yet",
    createFailed: "Failed to create a Listen Together room",
    joinFailed: "Failed to join the Listen Together room",
    notInRoom: "Not in a Listen Together room",
  },
} as const;

class RendererUnavailableError extends Error {
  constructor() {
    super("renderer unavailable");
    this.name = "RendererUnavailableError";
  }
}

interface PendingReply {
  resolve: (snapshot: ListenTogetherSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SyncState {
  initialized: boolean;
  inRoom: boolean;
  busy: boolean;
  room: ListenTogetherRoom | null;
  accountId: string;
  leaderId: string;
  error: string;
  lastSongId: string;
  lastQueue: string;
  lastPlaying: boolean;
  lastSeekRevision: number;
  lastEndRevision: number;
  lastRemoteSequence: number;
  lastRemoteSignature: string;
  commandSequence: number;
  playlistVersion: number;
  pendingEndAt: number;
  ticks: number;
  lastInitAttempt: number;
  rateLimitUntil: number;
  rateLimitFailures: number;
  awaitingTransition: boolean;
  autoAdvanceBlocked: boolean;
}

const state: SyncState = {
  initialized: false,
  inRoom: false,
  busy: false,
  room: null,
  accountId: "",
  leaderId: "",
  error: "",
  lastSongId: "",
  lastQueue: "",
  lastPlaying: false,
  lastSeekRevision: 0,
  lastEndRevision: 0,
  lastRemoteSequence: -1,
  lastRemoteSignature: "",
  commandSequence: 0,
  playlistVersion: 0,
  pendingEndAt: 0,
  ticks: 0,
  lastInitAttempt: 0,
  rateLimitUntil: 0,
  rateLimitFailures: 0,
  awaitingTransition: false,
  autoAdvanceBlocked: false,
};

const pending = new Map<number, PendingReply>();
let requestId = 0;
let tail: Promise<void> = Promise.resolve();
let running = false;
let published = "";

const copy = () => COPY[getLocale()];

const errorText = (error: unknown): string => {
  if (error instanceof RendererUnavailableError) return copy().notReady;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return plain(message, 280) || copy().createFailed;
};

const invitationOf = (): string => {
  if (!state.inRoom || !state.room) return "";
  return listenTogetherShareUrl(state.room.id, state.accountId, state.lastSongId);
};

const currentView = (): ListenTogetherView => ({
  inRoom: state.inRoom,
  roomId: state.room?.id ?? "",
  members: state.room?.members ?? [],
  invitation: invitationOf(),
  error: state.error,
  busy: state.busy,
});

const publish = (): void => {
  const view = currentView();
  const signature = JSON.stringify(view);
  if (signature === published) return;
  published = signature;
  sendToMain("listen-together:view", view);
};

const toast = (code: ListenTogetherToast): void => {
  sendToMain("listen-together:toast", code);
};

const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const rendererReady = (): boolean => {
  const win = getMainWindow();
  return !!win && !win.isDestroyed() && !win.webContents.isLoading();
};

const askRenderer = (
  kind: "snapshot" | "command",
  action?: ListenTogetherCommand,
): Promise<ListenTogetherSnapshot> => {
  if (!rendererReady()) return Promise.reject(new RendererUnavailableError());
  const id = ++requestId;
  const slow =
    action?.type === "replaceQueue" || action?.type === "select" || action?.type === "next";
  const { promise, resolve, reject } = Promise.withResolvers<ListenTogetherSnapshot>();
  const timer = setTimeout(
    () => {
      pending.delete(id);
      reject(new Error("listen together renderer timeout"));
    },
    slow ? 30_000 : 8_000,
  );
  pending.set(id, { resolve, reject, timer });
  sendToMain("listen-together:request", { id, kind, command: action });
  return promise;
};

const playback = (): Promise<ListenTogetherSnapshot> => askRenderer("snapshot");

const command = (action: ListenTogetherCommand): Promise<ListenTogetherSnapshot> =>
  askRenderer("command", action);

const blockAutoAdvance = async (blocked: boolean): Promise<void> => {
  if (state.autoAdvanceBlocked === blocked) return;
  await command({ type: "blockAutoAdvance", blocked });
  state.autoAdvanceBlocked = blocked;
};

/** 渲染层对快照 / 播放请求的回复 */
export const replyListenTogether = (reply: ListenTogetherReply): void => {
  const item = pending.get(reply.id);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(reply.id);
  if (reply.ok && reply.data) item.resolve(reply.data);
  else item.reject(new Error(reply.error || "listen together command failed"));
};

const call = async (operation: string, params: Record<string, unknown> = {}): Promise<unknown> => {
  const { body } = await callNetease("listen_together", { operation, ...params });
  assertListenOk(body);
  return body;
};

const accountId = async (): Promise<string> => {
  if (!getNeteaseCookies().MUSIC_U) return "";
  const { body } = await callNetease("login_status");
  const status = body as LoginStatusBody;
  const userId = status.data?.profile?.userId;
  return userId ? String(userId) : "";
};

const baseline = (snapshot: ListenTogetherSnapshot): void => {
  state.lastSongId = snapshot.currentSongId;
  state.lastQueue = idsSignature(snapshot.queueSongIds);
  state.lastPlaying = snapshot.playing;
  state.lastSeekRevision = snapshot.seekRevision;
  state.lastEndRevision = snapshot.endRevision;
};

const reportPlaylist = async (snapshot: ListenTogetherSnapshot): Promise<void> => {
  if (!state.room) return;
  state.playlistVersion += 1;
  const playlist = {
    commandType: "REPLACE",
    version: [{ userId: Number(state.accountId || 0), version: state.playlistVersion }],
    anchorSongId: "",
    anchorPosition: -1,
    randomList: snapshot.queueSongIds,
    displayList: snapshot.queueSongIds,
  };
  await call("reportPlaylist", {
    roomId: state.room.id,
    playlistParam: JSON.stringify(playlist),
  });
};

const reportCommand = async (
  type: string,
  formerSongId: string,
  targetSongId: string,
  progressMs: number,
  playing: boolean,
): Promise<void> => {
  if (!state.room) return;
  state.commandSequence = Math.max(state.commandSequence + 1, Date.now());
  const commandInfo = {
    commandType: type,
    progress: Math.max(0, Math.round(progressMs)),
    playStatus: playing ? "PLAY" : "PAUSE",
    formerSongId: formerSongId || "0",
    targetSongId: targetSongId || "0",
    clientSeq: state.commandSequence,
  };
  await call("reportCommand", {
    roomId: state.room.id,
    commandInfo: JSON.stringify(commandInfo),
  });
};

const reportLocalChanges = async (snapshot: ListenTogetherSnapshot): Promise<void> => {
  // 远端切歌还在解析音源。这段过渡态不能当成用户刚切了一首歌再报回去。
  if (snapshot.transitioning) {
    state.awaitingTransition = true;
    baseline(snapshot);
    return;
  }
  if (state.awaitingTransition) {
    state.awaitingTransition = false;
    baseline(snapshot);
    return;
  }
  const queueSignature = idsSignature(snapshot.queueSongIds);
  if (queueSignature !== state.lastQueue && snapshot.queueSongIds.length > 0) {
    await reportPlaylist(snapshot);
  }
  const song = snapshot.currentSongId;
  if (song && song !== state.lastSongId) {
    const former = state.lastSongId;
    state.leaderId = state.accountId;
    state.pendingEndAt = 0;
    await reportCommand("GOTO", former || "0", song, snapshot.positionMs, snapshot.playing);
  } else if (snapshot.seekRevision !== state.lastSeekRevision && song) {
    await reportCommand("PROGRESS", song, song, snapshot.positionMs, snapshot.playing);
  } else if (snapshot.playing !== state.lastPlaying && song) {
    await reportCommand(
      snapshot.playing ? "PLAY" : "PAUSE",
      song,
      song,
      snapshot.positionMs,
      snapshot.playing,
    );
  }
  baseline(snapshot);
};

const commandToast = (type: string): ListenTogetherToast | "" => {
  switch (type.toUpperCase()) {
    case "PROGRESS":
      return "remoteProgress";
    case "GOTO":
    case "NEXT":
    case "PREV":
      return "remoteTrack";
    case "PLAY":
      return "remotePlay";
    case "PAUSE":
      return "remotePause";
    default:
      return "";
  }
};

const applyCommand = async (
  remote: RemoteCommand,
  target: { type: string; songId: string; positionMs: number; playing: boolean },
  songIds: string[],
  queueChanged: boolean,
  selectedSong: string,
): Promise<void> => {
  if (queueChanged) {
    await command({
      type: "replaceQueue",
      songIds,
      currentSongId: selectedSong,
      positionMs: target.positionMs,
      playing: target.playing,
    });
    return;
  }
  if (
    (target.type === "GOTO" || target.type === "NEXT" || target.type === "PREV") &&
    target.songId
  ) {
    state.leaderId = remote.accountId;
    state.pendingEndAt = 0;
    await command({
      type: "select",
      songId: target.songId,
      positionMs: target.positionMs,
      playing: target.playing,
    });
    return;
  }
  if (target.type === "PROGRESS") {
    await command({ type: "seek", positionMs: target.positionMs });
    return;
  }
  if (target.type === "PLAY") {
    await command({ type: "play" });
    return;
  }
  if (target.type === "PAUSE") await command({ type: "pause" });
};

const applySnapshot = async (
  remote: RemoteSnapshot,
  initial: boolean,
  forcePaused: boolean,
): Promise<ListenTogetherSnapshot> => {
  const fresh =
    !!(initial && remote.command) ||
    isNewRemote(
      remote.command,
      state.accountId,
      state.lastRemoteSignature,
      state.lastRemoteSequence,
    );
  const target = remotePlaybackTarget(remote.command, fresh, initial, forcePaused);
  const local = await playback();
  const songIds = remote.songIds;
  const queueChanged =
    songIds.length > 0 && idsSignature(songIds) !== idsSignature(local.queueSongIds);
  // 列表先到、切歌指令还没到时，不要用旧进度去播新队列里对不上的歌。
  if (!initial && queueChanged && !fresh && !songIds.includes(local.currentSongId)) {
    baseline(local);
    return local;
  }
  const desired =
    target && fresh
      ? target
      : {
          type: "",
          songId: "",
          positionMs: local.positionMs,
          playing: forcePaused ? false : local.playing,
        };
  if (queueChanged) {
    let selected = desired.songId || local.currentSongId || songIds[0];
    if (!songIds.includes(selected)) selected = songIds[0];
    await command({
      type: "replaceQueue",
      songIds,
      currentSongId: selected,
      positionMs: desired.positionMs,
      playing: desired.playing,
    });
  } else if (fresh && remote.command && target) {
    await applyCommand(remote.command, target, songIds, false, desired.songId);
  }
  if (forcePaused) await command({ type: "pause" });
  if (fresh && remote.command) {
    state.lastRemoteSignature = commandSignature(remote.command);
    state.lastRemoteSequence = Math.max(state.lastRemoteSequence, remote.command.sequence || 0);
    if (!initial) {
      const code = commandToast(remote.command.type);
      if (code) toast(code);
    }
  }
  const after = await playback();
  baseline(after);
  return after;
};

const setRoom = async (room: ListenTogetherRoom): Promise<void> => {
  state.initialized = true;
  state.room = room;
  state.inRoom = true;
  state.leaderId = pickLeader(state.accountId, room);
  state.pendingEndAt = 0;
  await blockAutoAdvance(true);
  publish();
};

const clearRoom = async (): Promise<void> => {
  state.initialized = true;
  state.inRoom = false;
  state.room = null;
  state.leaderId = "";
  state.lastSongId = "";
  state.lastQueue = "";
  state.pendingEndAt = 0;
  state.rateLimitUntil = 0;
  state.rateLimitFailures = 0;
  state.awaitingTransition = false;
  await blockAutoAdvance(false);
  publish();
};

const handleNaturalEnd = async (snapshot: ListenTogetherSnapshot): Promise<void> => {
  const revision = snapshot.endRevision;
  if (revision !== state.lastEndRevision) {
    if (!state.leaderId || state.leaderId === state.accountId) {
      state.leaderId = state.accountId;
      await command({ type: "next" });
      state.lastEndRevision = revision;
      return;
    }
    state.lastEndRevision = revision;
    state.pendingEndAt = Date.now();
  }
  if (state.pendingEndAt && Date.now() - state.pendingEndAt >= 3500) {
    state.leaderId = state.accountId;
    await command({ type: "next" });
    state.pendingEndAt = 0;
  }
};

const restore = async (): Promise<void> => {
  state.accountId = await accountId();
  if (!state.accountId) {
    state.initialized = true;
    return;
  }
  const status = statusFromResponse(await call("status"));
  if (!status.inRoom || !status.room) {
    state.initialized = true;
    await clearRoom();
    return;
  }
  await setRoom(status.room);
  const remote = snapshotFromResponse(await call("snapshot", { roomId: status.room.id }));
  const local = await applySnapshot(remote, true, true);
  if (local.currentSongId) {
    await reportCommand("PAUSE", local.currentSongId, local.currentSongId, local.positionMs, false);
  }
  state.initialized = true;
  toast("restored");
  publish();
};

const ensureInitialized = async (): Promise<void> => {
  if (state.initialized) return;
  const now = Date.now();
  if (now - state.lastInitAttempt < 5000) return;
  state.lastInitAttempt = now;
  try {
    await restore();
    state.error = "";
    publish();
  } catch (error) {
    if (error instanceof RendererUnavailableError) return;
    state.error = errorText(error);
    neteaseLog.warn("[listen-together] restore failed:", error);
    publish();
  }
};

const registerSyncFailure = (error: unknown): void => {
  state.error = errorText(error);
  if (!isRateLimited(error)) return;
  state.rateLimitFailures += 1;
  if (state.rateLimitFailures > 3) {
    state.rateLimitUntil = Number.MAX_SAFE_INTEGER;
    state.error = copy().rateLimitStop;
    return;
  }
  const delay = rateLimitDelayMs(state.rateLimitFailures);
  state.rateLimitUntil = Date.now() + delay;
  state.error = copy().rateLimitWait(Math.round(delay / 1000));
};

const tick = async (): Promise<void> => {
  state.ticks += 1;
  if (!state.inRoom) {
    if (state.initialized && state.ticks % 10 !== 0) return;
    if (!state.initialized && Date.now() - state.lastInitAttempt < 5000) return;
    state.initialized = false;
    await ensureInitialized();
    return;
  }
  if (Date.now() < state.rateLimitUntil) return;
  try {
    await blockAutoAdvance(true);
    await handleNaturalEnd(await playback());
    await reportLocalChanges(await playback());
    if (!state.room) return;
    const remote = snapshotFromResponse(await call("snapshot", { roomId: state.room.id }));
    const local = await applySnapshot(remote, false, false);
    if (state.ticks % 8 === 0) {
      await call("heartbeat", {
        roomId: state.room.id,
        songId: local.currentSongId || "0",
        playStatus: local.playing ? "PLAY" : "PAUSE",
        progress: Math.max(0, Math.round(local.positionMs)),
      });
    }
    if (state.ticks % 12 === 0) {
      const status = statusFromResponse(await call("status"));
      if (!status.inRoom || !status.room) {
        await clearRoom();
        return;
      }
      state.room = status.room;
      publish();
    }
    if (state.error || state.rateLimitFailures || state.rateLimitUntil) {
      state.error = "";
      state.rateLimitFailures = 0;
      state.rateLimitUntil = 0;
      publish();
    }
    publish();
  } catch (error) {
    if (error instanceof RendererUnavailableError) return;
    registerSyncFailure(error);
    neteaseLog.warn("[listen-together] sync failed:", error);
    publish();
  }
};

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** 启动同步循环。重复调用无效果 */
export const startListenTogether = (): void => {
  if (running) return;
  running = true;
  void (async () => {
    while (running) {
      await withLock(tick);
      await delay(1000);
    }
  })();
};

/** 当前房间视图，不打网络 */
export const getListenTogetherView = (): ListenTogetherView => currentView();

const noteFailure = (error: unknown): void => {
  state.error = errorText(error);
  publish();
};

/** 用当前播放队列创建房间 */
export const createListenTogether = (): Promise<ListenTogetherView> =>
  withLock(async () => {
    state.busy = true;
    state.error = "";
    publish();
    try {
      const [id, local] = await Promise.all([accountId(), playback()]);
      if (!id) throw new Error(copy().needLogin);
      if (!local.currentSongId || local.queueSongIds.length === 0)
        throw new Error(copy().needQueue);
      state.accountId = id;
      const room = roomFromResponse(await call("create"));
      if (!room) throw new Error(copy().createFailed);
      await setRoom(room);
      await reportPlaylist(local);
      await reportCommand("GOTO", "0", local.currentSongId, local.positionMs, local.playing);
      state.leaderId = state.accountId;
      baseline(local);
      toast("created");
      neteaseLog.info(`[listen-together] created room ${room.id}`);
    } catch (error) {
      if (!(error instanceof RendererUnavailableError)) {
        neteaseLog.warn("[listen-together] create failed:", error);
      }
      noteFailure(error);
    } finally {
      state.busy = false;
    }
    publish();
    return currentView();
  });

/** 加入邀请链接或房间 ID */
export const joinListenTogether = (invitation: string): Promise<ListenTogetherView> =>
  withLock(async () => {
    const parsed = parseInvitation(invitation);
    if ("error" in parsed) {
      state.error = copy()[parsed.error];
      publish();
      return currentView();
    }
    state.busy = true;
    state.error = "";
    publish();
    try {
      const id = await accountId();
      if (!id) throw new Error(copy().needLogin);
      state.accountId = id;
      const room = roomFromResponse(
        await call("join", { roomId: parsed.roomId, inviterId: parsed.inviterId || "0" }),
        parsed.roomId,
      );
      if (!room) throw new Error(copy().joinFailed);
      await setRoom(room);
      const remote = snapshotFromResponse(await call("snapshot", { roomId: room.id }));
      await applySnapshot(remote, true, false);
      toast("joined");
      neteaseLog.info(`[listen-together] joined room ${room.id}`);
    } catch (error) {
      neteaseLog.warn("[listen-together] join failed:", error);
      noteFailure(error);
    } finally {
      state.busy = false;
    }
    publish();
    return currentView();
  });

/** 退出当前房间 */
export const leaveListenTogether = (): Promise<ListenTogetherView> =>
  withLock(async () => {
    if (!state.inRoom || !state.room) {
      state.error = copy().notInRoom;
      publish();
      return currentView();
    }
    state.busy = true;
    state.error = "";
    publish();
    try {
      const id = state.room.id;
      await call("end", { roomId: id });
      await clearRoom();
      toast("left");
      neteaseLog.info(`[listen-together] left room ${id}`);
    } catch (error) {
      neteaseLog.warn("[listen-together] leave failed:", error);
      noteFailure(error);
    } finally {
      state.busy = false;
    }
    publish();
    return currentView();
  });
