import { useLayoutEffect, useState, type MutableRefObject, type RefObject } from 'react';
import type { InputController } from '../input';
import type { GamepadPoller } from '../gamepad';

export type TvDisplay = 'full' | 'lights' | 'bare';
export type TvPlayerStatus = 'opening' | 'game' | 'blocked' | 'paused' | 'idle';
export interface TvPlayerHandle { leave: () => Promise<void>; resume: () => void; }
export interface TvPlayerOptions {
  input: InputController;
  gamepad: MutableRefObject<GamepadPoller | null>;
  handle: MutableRefObject<TvPlayerHandle | null>;
  report: (status: TvPlayerStatus) => void;
  blocked: boolean;
  display: TvDisplay;
  integer: boolean;
  volume: number;
  muted: boolean;
  vibration: boolean;
}

export function lcdSize(availableWidth: number, availableHeight: number, width: number, height: number, dpr: number, integer: boolean) {
  const fit = Math.min(availableWidth * dpr / width, availableHeight * dpr / height);
  const scale = integer && fit >= 1 ? Math.floor(fit) : fit;
  return { width: width * scale / dpr, height: height * scale / dpr };
}

export function useTvLcd(stage: RefObject<HTMLElement>, enabled: boolean, width: number, height: number, integer: boolean) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = stage.current;
    if (!enabled || !element) return;
    const resize = () => setSize(lcdSize(element.clientWidth, element.clientHeight, width, height, devicePixelRatio || 1, integer));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [stage, enabled, width, height, integer]);
  return size;
}
