/**
 * 网易云一起听。
 *
 * params.operation:
 * - create          创建房间
 * - status          当前是否在房间里
 * - join            接受邀请。roomId、inviterId
 * - snapshot        拉取房间播放列表与最新指令。roomId
 * - reportPlaylist  上报整表替换。roomId、playlistParam（JSON 字符串）
 * - reportCommand   上报播放指令。roomId、commandInfo（JSON 字符串）
 * - heartbeat       心跳。roomId、songId、playStatus、progress
 * - end             退出房间。roomId
 *
 * 这些接口都是实时状态，调用方必须把 listen_together 放进 NON_CACHEABLE。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogether: NeteaseModule = (query, request) => {
  const roomId = query.roomId;
  switch (query.operation) {
    case "create":
      return request(
        "/api/listen/together/room/create",
        { refer: "songplay_more" },
        createOption(query, "eapi"),
      );
    case "status":
      return request("/api/listen/together/status/get", {}, createOption(query, "weapi"));
    case "join":
      return request(
        "/api/listen/together/play/invitation/accept",
        { refer: "inbox_invite", roomId, inviterId: query.inviterId || "0" },
        createOption(query, "eapi"),
      );
    case "snapshot":
      return request(
        "/api/listen/together/sync/playlist/get",
        { roomId },
        createOption(query, "eapi"),
      );
    case "reportPlaylist":
      return request(
        "/api/listen/together/sync/list/command/report",
        { roomId, playlistParam: query.playlistParam },
        createOption(query, "eapi"),
      );
    case "reportCommand":
      return request(
        "/api/listen/together/play/command/report",
        { roomId, commandInfo: query.commandInfo },
        createOption(query, "eapi"),
      );
    case "heartbeat":
      return request(
        "/api/listen/together/heartbeat",
        {
          roomId,
          songId: query.songId || "0",
          playStatus: query.playStatus,
          progress: query.progress,
        },
        createOption(query, "eapi"),
      );
    case "end":
      return request("/api/listen/together/end/v2", { roomId }, createOption(query, "eapi"));
    default:
      throw new Error(`unknown listen together operation: ${String(query.operation)}`);
  }
};

export default listenTogether;
