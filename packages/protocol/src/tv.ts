export const TV_GAME_KEYS = ['up', 'down', 'left', 'right', 'fire', 'softLeft', 'softRight', 'clear', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'star', 'd0', 'pound'] as const;
export const TV_KEYS = [...TV_GAME_KEYS, 'menu', 'back'] as const;
export type TvKey = typeof TV_KEYS[number];
export type TvView = 'navigation' | 'game' | 'search' | 'address';
export interface TvModeState { view: TvView; revision: number }
export type TvRemoteInput =
  | { t: 'key'; key: TvKey; down: boolean; revision: number }
  | { t: 'text'; value: string; revision: number }
  | { t: 'release' };
export type TvNotice =
  | { t: 'code'; code: string; expires: number }
  | { t: 'pending'; check?: string }
  | { t: 'paired'; ticket?: string }
  | { t: 'remote-offline' }
  | { t: 'unpaired' }
  | { t: 'mode'; mode: TvModeState }
  | { t: 'error'; message: string }
  | TvRemoteInput;
