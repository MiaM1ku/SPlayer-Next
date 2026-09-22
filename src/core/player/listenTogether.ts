/**
 * 把主进程的一起听动作落到本地播放器上，并回报播放快照。
 */

import type { Track } from "@shared/types/player";
import type {
  ListenTogetherCommand,
  ListenTogetherRequest,
  ListenTogetherSnapshot,
} from "@shared/types/listenTogether";
import { netease } from "@/apis/netease";
import { useMediaStore } from "@/stores/media";
import * as queue from "@/stores/queue";
import { useStatusStore } from "@/stores/status";
import * as playback from "@/services/playback";
import { ensureOk, songsToTracks } from "@/utils/format/netease";
import {
  naturalEndRevision,
  seekRevisionValue,
  setAutoAdvanceBlocked,
} from "./listenTogetherState";

/** 播放器核心注入的动作。桥接不直接 import player/index，避免循环依赖 */
export interface ListenTogetherPlayback {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  next: () => Promise<void>;
  select: (index: number, positionMs: number, playing: boolean) => Promise<void>;
  replace: (tracks: Track[], index: number, positionMs: number, playing: boolean) => Promise<void>;
}

let playbackApi: ListenTogetherPlayback | null = null;
let unsubscribe: (() => void) | null = null;

/** 由 initPlayer 注入真正的播放实现 */
export const bindListenTogetherPlayback = (api: ListenTogetherPlayback): void => {
  playbackApi = api;
};

const snapshot = (): ListenTogetherSnapshot => {
  const status = useStatusStore();
  const track = useMediaStore().track;
  const entries = queue.queue.value;
  const owned =
    !status.fmMode && entries.length > 0 && entries.every((item) => item.source === "netease");
  return {
    currentSongId: track?.source === "netease" ? track.id : "",
    queueSongIds: owned ? entries.map((item) => item.id) : [],
    positionMs: Math.max(0, Math.round(playback.getCurrentTime())),
    durationMs: Math.max(0, status.duration),
    playing: status.isPlaying,
    transitioning: status.trackLoading,
    seekRevision: seekRevisionValue(),
    endRevision: naturalEndRevision(),
  };
};

const fetchTracks = async (ids: string[]): Promise<Track[]> => {
  const byId = new Map<string, Track>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const body = ensureOk(await netease.song_detail({ ids: chunk.join(",") }));
    for (const track of songsToTracks(body.songs)) byId.set(track.id, track);
  }
  const tracks: Track[] = [];
  for (const id of ids) {
    const track = byId.get(id);
    if (track && !tracks.some((item) => item.id === track.id)) tracks.push(track);
  }
  return tracks;
};

const apply = async (action: ListenTogetherCommand): Promise<void> => {
  const api = playbackApi;
  if (!api) throw new Error("player is not ready");
  switch (action.type) {
    case "play":
      await api.play();
      return;
    case "pause":
      await api.pause();
      return;
    case "seek":
      await api.seek(action.positionMs);
      return;
    case "next":
      await api.next();
      return;
    case "blockAutoAdvance":
      setAutoAdvanceBlocked(action.blocked);
      return;
    case "select": {
      const index = queue.queue.value.findIndex(
        (track) => track.source === "netease" && track.id === action.songId,
      );
      if (index < 0) throw new Error("目标歌曲不在播放队列中");
      await api.select(index, action.positionMs, action.playing);
      return;
    }
    case "replaceQueue": {
      const tracks = await fetchTracks(action.songIds);
      if (tracks.length === 0) throw new Error("没有拿到房间里的歌曲信息");
      const found = tracks.findIndex((track) => track.id === action.currentSongId);
      await api.replace(tracks, found < 0 ? 0 : found, action.positionMs, action.playing);
    }
  }
};

const handle = async (request: ListenTogetherRequest): Promise<void> => {
  try {
    if (request.kind === "command" && request.command) await apply(request.command);
    window.api.listenTogether.reply({ id: request.id, ok: true, data: snapshot() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    window.api.listenTogether.reply({ id: request.id, ok: false, error: message });
  }
};

/** 安装主进程请求监听。重复调用无效果 */
export const installListenTogetherBridge = (): void => {
  if (unsubscribe) return;
  unsubscribe = window.api.listenTogether.onRequest((request) => {
    void handle(request);
  });
};
