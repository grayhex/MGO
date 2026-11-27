import { useEffect, useLayoutEffect, useRef } from 'react';
import { GamepadPoller, loadPadProfile, PAD_NAVIGATION, type PadState } from '../gamepad';
import type { Action, InputController } from '../input';
import { phoneAction } from '../phoneRemote';

export type TvKey = Action | 'menu' | 'back' | 'pageUp' | 'pageDown';

const uiKey: Partial<Record<Action, TvKey>> = {
  softRight: 'back', softLeft: 'menu',
  ...PAD_NAVIGATION, star: 'back', pound: 'menu',
};

export function useTvInput(input: InputController, gameId: string | null, gameplay: boolean,
  gamepadEnabled: boolean, onUi: (key: TvKey) => void, onPadState: (state: PadState) => void) {
  const gamepad = useRef<GamepadPoller | null>(null);
  const current = useRef({ gameplay, onUi, onPadState });
  current.current = { gameplay, onUi, onPadState };

  useEffect(() => {
    const poller = new GamepadPoller(input);
    poller.reserveMenu = true;
    poller.setUiMode(!current.current.gameplay);
    poller.onUi = action => {
      const route = current.current.onUi;
      if (action === 'ui:menu') route('menu');
      else if (action === 'ui:back') route('back');
      else if (action !== 'ui:fullscreen' && action !== 'ui:lights') route(uiKey[action] ?? action);
    };
    poller.onState = value => current.current.onPadState(value);
    poller.onPage = direction => current.current.onUi(direction < 0 ? 'pageUp' : 'pageDown');
    gamepad.current = poller;
    if (gamepadEnabled) poller.start();
    return () => { poller.stop(); gamepad.current = null; };
  }, [input, gamepadEnabled]);

  useEffect(() => {
    gamepad.current?.setProfile(loadPadProfile(gameId ?? undefined));
  }, [gameId, gamepadEnabled]);
  useLayoutEffect(() => {
    input.releaseAll();
    gamepad.current?.setUiMode(!gameplay);
  }, [input, gameplay, gamepadEnabled]);

  useEffect(() => {
    const keys = new Set<string>();

    const down = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (phoneAction(event)) {
        if (current.current.gameplay) input.onKeyDown(event);
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const editing = target instanceof HTMLInputElement && !['checkbox', 'range', 'radio', 'button'].includes(target.type) ||
        target instanceof HTMLTextAreaElement || !!target?.isContentEditable;
      if (editing && event.code !== 'Escape') return;
      const always = event.code === 'KeyM' ? 'menu' : event.code === 'Escape' ? 'back' : undefined;
      if (event.repeat) {
        if (keys.has(event.code)) event.preventDefault();
        return;
      }
      if (keys.has(event.code)) return;
      keys.add(event.code);

      if (always) { event.preventDefault(); current.current.onUi(always); return; }
      if (current.current.gameplay) input.onKeyDown(event);
      else {
        const logical = input.actionForKeyboard(event.code);
        const key = event.code === 'Backspace' ? 'back' : logical && (uiKey[logical] ?? logical);
        if (key) { event.preventDefault(); current.current.onUi(key); }
      }
    };

    const up = (event: KeyboardEvent) => {
      keys.delete(event.code);
      input.onKeyUp(event);
    };

    const suspended = () => { keys.clear(); input.releaseAll(); };
    const hidden = () => { if (document.hidden) suspended(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', suspended);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', suspended);
      document.removeEventListener('visibilitychange', hidden);
      suspended();
    };
  }, [input]);
  return gamepad;
}
