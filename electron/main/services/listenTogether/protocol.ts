/**
 * 网易云一起听协议的纯函数。
 *
 * 行为对齐 QPlayer 网易云插件 `src/together.js` 与 `listenTogether()`：
 * 房间 DTO、邀请解析、远端指令去重、列表与进度的采用规则都在这里，方便单测。
 */

import type { ListenTogetherMember, ListenTogetherRoom } from "@shared/types/listenTogether";

/** 远端播放指令 */
export interface RemoteCommand {
  accountId: string;
  type: string;
  formerSongId: string;
  targetSongId: string;
  progressMs: number;
  playing: boolean;
  sequence: number;
}

/** 一次房间快照：队列与可选的最新指令 */
export interface RemoteSnapshot {
  songIds: string[];
  command: RemoteCommand | null;
}

/** 邀请解析失败原因，由调用方翻译 */
export type InvitationError =
  "empty" | "tooLong" | "badEncoding" | "wrongProvider" | "badRoomId" | "badInviter";

/** 邀请解析结果 */
export type InvitationParse = { roomId: string; inviterId: string } | { error: InvitationError };

/** 采用远端指令后，本地应落到的进度与播放态 */
export interface RemotePlaybackTarget {
  type: string;
  songId: string;
  positionMs: number;
  playing: boolean;
}

/** 网易云房间 JSON。字段保持 unknown，读取时再收窄 */
interface WireRoom {
  roomId?: unknown;
  creatorId?: unknown;
  roomUsers?: unknown;
  users?: unknown;
}

/** 创建 / 加入 / 状态接口的 data */
interface WireData {
  inRoom?: unknown;
  roomInfo?: unknown;
  playlist?: unknown;
  playCommand?: unknown;
  commandInfo?: unknown;
}

interface WireBody {
  code?: unknown;
  message?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface WireCommand {
  commandType?: unknown;
  playStatus?: unknown;
  userId?: unknown;
  formerSongId?: unknown;
  targetSongId?: unknown;
  progress?: unknown;
  serverSeq?: unknown;
}

interface WirePlaylist {
  playMode?: unknown;
  randomList?: unknown;
  displayList?: unknown;
}

interface WireList {
  result?: unknown;
}

interface WireUser {
  userId?: unknown;
  nickname?: unknown;
  avatarUrl?: unknown;
}

interface ErrorCause {
  message?: unknown;
  cause?: unknown;
}

/** 网易云 JSON 对象在边界上收成具名结构；非对象当空对象，后续字段再逐个收窄 */
const wire = <T>(value: unknown): T =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : ({} as T);

const text = (value: unknown): string => (value == null ? "" : String(value));

/** 去掉控制字符并截断，避免异常服务端文案撑破界面 */
export const plain = (value: unknown, limit: number): string => {
  let out = "";
  for (const char of text(value)) {
    const code = char.codePointAt(0) ?? 0;
    out += code <= 0x1f || code === 0x7f ? " " : char;
  }
  return out.length > limit ? out.slice(0, limit) : out;
};

/** 业务 code 非 200 时抛错，让同步循环走统一失败路径 */
export const assertListenOk = (body: unknown): void => {
  const row = wire<WireBody>(body);
  if (row.code == null || row.code === "") return;
  if (Number(row.code) === 200) return;
  const message = plain(row.message || row.msg || `listen together ${row.code}`, 280);
  throw new Error(message || `listen together ${row.code}`);
};

const avatarUrl = (value: unknown): string => {
  const url = text(value);
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
};

const toMember = (user: unknown): ListenTogetherMember => {
  const row = wire<WireUser>(user);
  return {
    id: text(row.userId),
    displayName: plain(row.nickname, 64),
    avatarUrl: avatarUrl(row.avatarUrl),
  };
};

/** 网易云房间对象 → 应用层房间；没有 roomId 时返回 null */
export const toRoom = (raw: unknown, fallbackId = ""): ListenTogetherRoom | null => {
  const row = wire<WireRoom>(raw);
  const id = text(row.roomId || fallbackId).trim();
  if (!id) return null;
  const users = Array.isArray(row.roomUsers)
    ? row.roomUsers
    : Array.isArray(row.users)
      ? row.users
      : [];
  return {
    id,
    creatorAccountId: row.creatorId ? text(row.creatorId) : "",
    members: users.map(toMember),
  };
};

/** 创建 / 加入接口的 data.roomInfo（或 data 本身） */
export const roomFromResponse = (body: unknown, fallbackId = ""): ListenTogetherRoom | null => {
  const data = wire<WireData>(wire<WireBody>(body).data);
  return toRoom(data.roomInfo ?? data, fallbackId);
};

/** 状态接口 */
export const statusFromResponse = (
  body: unknown,
): { inRoom: boolean; room: ListenTogetherRoom | null } => {
  const data = wire<WireData>(wire<WireBody>(body).data);
  return {
    inRoom: !!data.inRoom,
    room: data.roomInfo ? toRoom(data.roomInfo) : null,
  };
};

/** 指令签名，用于忽略回声 */
export const commandSignature = (command: RemoteCommand): string =>
  [
    command.accountId,
    command.type,
    command.formerSongId,
    command.targetSongId,
    command.progressMs,
    command.playing,
  ].join("|");

/** 播放列表接口里的 playCommand / commandInfo */
export const commandFromRaw = (raw: unknown): RemoteCommand | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as WireCommand;
  const type = text(row.commandType);
  const typeUpper = type.toUpperCase();
  const playStatus = text(row.playStatus).toUpperCase();
  return {
    accountId: row.userId ? text(row.userId) : "",
    type,
    formerSongId: row.formerSongId ? text(row.formerSongId) : "",
    targetSongId: row.targetSongId ? text(row.targetSongId) : "",
    progressMs: Math.max(0, Number(row.progress || 0) || 0),
    playing:
      typeUpper === "PLAY" ||
      typeUpper === "GOTO" ||
      typeUpper === "NEXT" ||
      typeUpper === "PREV" ||
      playStatus === "PLAY" ||
      playStatus === "PLAYING",
    sequence: Number(row.serverSeq || 0) || 0,
  };
};

const songIdsOf = (list: unknown): string[] => {
  const result = Array.isArray(list) ? list : wire<WireList>(list).result;
  if (!Array.isArray(result)) return [];
  return result.map((id) => text(id)).filter(Boolean);
};

/** 同步列表接口 → 歌曲 id 与最新指令。随机模式读 randomList，否则 displayList */
export const snapshotFromResponse = (body: unknown): RemoteSnapshot => {
  const data = wire<WireData>(wire<WireBody>(body).data);
  const playlist = wire<WirePlaylist>(data.playlist);
  const mode = text(playlist.playMode).toUpperCase();
  const shuffled = mode.includes("RANDOM") || mode.includes("SHUFFLE");
  const picked = shuffled ? playlist.randomList : playlist.displayList;
  return {
    songIds: songIdsOf(picked || playlist.displayList),
    command: commandFromRaw(data.playCommand || data.commandInfo),
  };
};

/**
 * 是否是一条尚未应用的他人指令。
 * 同一签名视为回声；序号倒退的旧指令丢弃；序号为 0 时只看签名。
 */
export const isNewRemote = (
  command: RemoteCommand | null,
  accountId: string,
  lastSignature: string,
  lastSequence: number,
): boolean => {
  if (!command?.accountId || command.accountId === accountId) return false;
  if (commandSignature(command) === lastSignature) return false;
  if (command.sequence && command.sequence < lastSequence) return false;
  return true;
};

/**
 * 非初次同步的切歌进度归零，避免把上一首的毫秒数套到新歌上。
 * 初次进房保留服务端进度。forcePaused 用于重启后的恢复，避免突然出声。
 */
export const remotePlaybackTarget = (
  command: RemoteCommand | null,
  fresh: boolean,
  initial: boolean,
  forcePaused: boolean,
): RemotePlaybackTarget | null => {
  if (!fresh || !command) return null;
  const type = command.type.toUpperCase();
  const cut = !initial && (type === "GOTO" || type === "NEXT" || type === "PREV");
  return {
    type,
    songId: command.targetSongId,
    positionMs: cut ? 0 : command.progressMs,
    playing: forcePaused ? false : command.playing,
  };
};

/** 房主优先；没有房主时取自己与成员里最小的数字 id */
export const pickLeader = (accountId: string, room: ListenTogetherRoom | null): string => {
  if (room?.creatorAccountId) return room.creatorAccountId;
  const candidates = [accountId, ...(room?.members ?? []).map((member) => member.id)].filter(
    Boolean,
  );
  candidates.sort((left, right) => {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return candidates[0] ?? accountId;
};

/** 错误链上是否是频控。沿 cause 最多看 8 层 */
export const isRateLimited = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const row = wire<ErrorCause>(current);
    const value = text(row.message ?? current).toLowerCase();
    if (
      value.includes("429") ||
      value.includes("too many requests") ||
      value.includes("rate limit") ||
      value.includes("操作频繁")
    ) {
      return true;
    }
    current = row.cause;
  }
  return false;
};

/** 第 n 次频控的等待毫秒。1→30s，之后翻倍，封顶 120s */
export const rateLimitDelayMs = (failures: number): number =>
  Math.min(120_000, 30_000 * 2 ** (failures - 1));

/** 网易云官方一起听分享页，客户端里复制出来的就是这个地址 */
const SHARE_PAGE = "https://st.music.163.com/listen-together/share/index.html";

/**
 * 拼官方分享链接。
 * `roomId`、`inviterId`、`songId` 的顺序和客户端一致，好友在网易云里打开即可加入。
 */
export const listenTogetherShareUrl = (
  roomId: string,
  inviterId: string,
  songId: string,
): string => {
  const base = `${SHARE_PAGE}?roomId=${encodeURIComponent(roomId)}&inviterId=${encodeURIComponent(inviterId)}`;
  return songId ? `${base}&songId=${encodeURIComponent(songId)}` : base;
};

/**
 * 解析官方分享链接或裸房间 ID。
 * 文本里夹着「我的耳机分你一半」时，只取其中的 `st.music.163.com` 链接。
 */
export const parseInvitation = (value: unknown): InvitationParse => {
  const raw = text(value).trim();
  if (!raw) return { error: "empty" };
  if (raw.length > 4096) return { error: "tooLong" };
  const embedded = raw.match(/https?:\/\/st\.music\.163\.com\/listen-together\/share\/?\S*/i);
  const source = embedded ? embedded[0] : raw;
  const query = source.includes("?") ? source.slice(source.indexOf("?") + 1).split("#")[0] : source;
  const result: Record<string, string> = {};
  try {
    for (const part of query.split("&")) {
      const at = part.indexOf("=");
      if (at > 0) {
        result[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
      }
    }
  } catch {
    return { error: "badEncoding" };
  }
  if (!result.roomId && !source.includes("=") && !source.includes("/")) result.roomId = source;
  const roomId = text(result.roomId).trim();
  const inviterId = text(result.inviterId).trim();
  if (result.provider && result.provider !== "netease") return { error: "wrongProvider" };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) return { error: "badRoomId" };
  if (inviterId && !/^\d{1,24}$/.test(inviterId)) return { error: "badInviter" };
  return { roomId, inviterId };
};

/** 队列 id 签名 */
export const idsSignature = (values: readonly string[]): string => values.join(",");
