import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandFromRaw,
  idsSignature,
  isNewRemote,
  isRateLimited,
  parseInvitation,
  listenTogetherShareUrl,
  pickLeader,
  rateLimitDelayMs,
  remotePlaybackTarget,
  snapshotFromResponse,
  type RemoteCommand,
} from "./protocol";

const command = (patch: Partial<RemoteCommand> = {}): RemoteCommand => ({
  accountId: "2",
  type: "GOTO",
  formerSongId: "1",
  targetSongId: "9",
  progressMs: 1500,
  playing: true,
  sequence: 10,
  ...patch,
});

describe("一起听邀请", () => {
  it("接受裸房间 ID", () => {
    assert.deepEqual(parseInvitation("room_1"), { roomId: "room_1", inviterId: "" });
  });

  it("接受网易云官方一起听链接", () => {
    const url =
      "https://st.music.163.com/listen-together/share/index.html?roomId=9184633b30911d24329e90b401e4f4e5_1780068896&inviterId=7811860917&songId=2603903847";
    assert.deepEqual(parseInvitation(url), {
      roomId: "9184633b30911d24329e90b401e4f4e5_1780068896",
      inviterId: "7811860917",
    });
    assert.deepEqual(
      parseInvitation(
        "我的耳机分你一半，和我一起听歌吧~ https://st.music.163.com/listen-together/share?roomId=abc&inviterId=42&songId=1",
      ),
      { roomId: "abc", inviterId: "42" },
    );
    assert.equal(
      listenTogetherShareUrl(
        "9184633b30911d24329e90b401e4f4e5_1780068896",
        "7811860917",
        "2603903847",
      ),
      url,
    );
  });

  it("拒绝其它音源、坏 ID 和空输入", () => {
    assert.deepEqual(parseInvitation(""), { error: "empty" });
    assert.deepEqual(parseInvitation("qplayer://listen-together?provider=qq&roomId=a"), {
      error: "wrongProvider",
    });
    assert.deepEqual(parseInvitation("bad id"), { error: "badRoomId" });
    assert.deepEqual(parseInvitation("qplayer://listen-together?roomId=a&inviterId=nope"), {
      error: "badInviter",
    });
  });
});

describe("一起听远端指令", () => {
  it("忽略自己的指令、回声和更旧的序号", () => {
    const current = command();
    assert.equal(isNewRemote(command({ accountId: "1" }), "1", "", 0), false);
    assert.equal(isNewRemote(current, "1", "", 0), true);
    const signature = [
      current.accountId,
      current.type,
      current.formerSongId,
      current.targetSongId,
      current.progressMs,
      current.playing,
    ].join("|");
    assert.equal(isNewRemote(current, "1", signature, 10), false);
    assert.equal(isNewRemote(command({ sequence: 9 }), "1", "", 10), false);
    assert.equal(
      isNewRemote(command({ sequence: 11, targetSongId: "8" }), "1", signature, 10),
      true,
    );
  });

  it("切歌指令即使播放态字段是暂停也视为播放，非初次同步进度归零", () => {
    const parsed = commandFromRaw({
      userId: 7,
      commandType: "GOTO",
      playStatus: "PAUSE",
      targetSongId: "5",
      progress: 4000,
      serverSeq: 3,
    });
    assert.equal(parsed?.playing, true);
    assert.deepEqual(remotePlaybackTarget(parsed, true, false, false), {
      type: "GOTO",
      songId: "5",
      positionMs: 0,
      playing: true,
    });
    assert.equal(remotePlaybackTarget(parsed, true, true, true)?.playing, false);
    assert.equal(remotePlaybackTarget(parsed, true, true, true)?.positionMs, 4000);
  });

  it("随机模式读 randomList，否则读 displayList.result", () => {
    const random = snapshotFromResponse({
      data: {
        playlist: {
          playMode: "RANDOM",
          randomList: { result: [2, 1] },
          displayList: { result: [1] },
        },
      },
    });
    assert.deepEqual(random.songIds, ["2", "1"]);
    const ordered = snapshotFromResponse({
      data: { playlist: { displayList: { result: ["8", "9"] } } },
    });
    assert.equal(idsSignature(ordered.songIds), "8,9");
  });
});

describe("一起听房主与频控", () => {
  it("没有房主时选最小的数字 id", () => {
    assert.equal(pickLeader("20", { id: "r", creatorAccountId: "5", members: [] }), "5");
    assert.equal(
      pickLeader("20", {
        id: "r",
        creatorAccountId: "",
        members: [
          { id: "30", displayName: "", avatarUrl: "" },
          { id: "9", displayName: "", avatarUrl: "" },
        ],
      }),
      "9",
    );
  });

  it("识别 429 并按 30s 翻倍封顶", () => {
    assert.equal(isRateLimited(new Error("netease 429")), true);
    assert.equal(isRateLimited(new Error("操作频繁")), true);
    assert.equal(isRateLimited(new Error("offline")), false);
    assert.equal(rateLimitDelayMs(1), 30_000);
    assert.equal(rateLimitDelayMs(2), 60_000);
    assert.equal(rateLimitDelayMs(3), 120_000);
    assert.equal(rateLimitDelayMs(4), 120_000);
  });
});
