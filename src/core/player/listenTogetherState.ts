/**
 * 一起听占用的本地播放记账。
 *
 * 和播放器核心分开，避免同步桥接和 player/index 循环引用。
 * 进房后拦住自然结束时的自动切歌，改由主进程决定谁来切下一首。
 */

let autoAdvanceBlocked = false;
let endArmed = true;
let endRevision = 0;
let seekRevision = 0;

/** 进房时挡住本地自动切歌，退房时放开 */
export const setAutoAdvanceBlocked = (blocked: boolean): void => {
  autoAdvanceBlocked = blocked;
};

/** 当前是否由一起听接管自然结束 */
export const isAutoAdvanceBlocked = (): boolean => autoAdvanceBlocked;

/** 新的一首开始后，下一次自然结束可以再记一笔 */
export const armNaturalEnd = (): void => {
  endArmed = true;
};

/**
 * 曲目自然结束。同一首在重新武装前只记一次，
 * 避免进度事件在结尾反复把 endRevision 抬上去。
 * @returns 这次是不是新的一次自然结束
 */
export const noteNaturalEnd = (): boolean => {
  if (!autoAdvanceBlocked || !endArmed) return false;
  endArmed = false;
  endRevision += 1;
  return true;
};

/** 用户或远端 seek。上报侧用修订号判断进度是不是本地改的 */
export const noteSeek = (): void => {
  seekRevision += 1;
};

/** 当前自然结束修订号 */
export const naturalEndRevision = (): number => endRevision;

/** 当前 seek 修订号 */
export const seekRevisionValue = (): number => seekRevision;
