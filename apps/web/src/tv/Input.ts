import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TvKey } from '@mgo/protocol';
import { GamepadPoller, loadPadProfile, type PadState } from '../gamepad';
import type { Action, InputController } from '../input';
import { phoneAction, phoneMenuAction } from '../phoneRemote';

const uiKey: Partial<Record<Action, TvKey>> = {
  softRight: 'back', softLeft: 'menu',
  d2: 'up', d4: 'left', d5: 'fire', d6: 'right', d8: 'down', star: 'back', pound: 'menu',
};

export function useTvInput(input: InputController, gameId: string | null, gameplay: boolean,
  gamepadEnabled: boolean, onUi: (key: TvKey) => void, onPadState: (state: PadState) => void) {
  const gamepad = useRef<GamepadPoller | null>(null);
  const current = useRef({ gameplay, onUi, onPadState });
  current.current = { gameplay, onUi, onPadState };

  useEffect(() => {
    const poller = new GamepadPoller(input);
    poller.reserveMenu = true;
    poller.setUiMode(true);
    poller.onUi = action => {
      const route = current.current.onUi;
      if (action === 'ui:menu') route('menu');
      else if (action === 'ui:back') route('back');
      else if (action !== 'ui:fullscreen' && action !== 'ui:lights') route(uiKey[action] ?? action);
    };
    poller.onState = value => current.current.onPadState(value);
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
    let pound: { code: string; used: boolean; timer: ReturnType<typeof setTimeout> } | undefined;
    const clearPound = () => { if (pound) clearTimeout(pound.timer); pound = undefined; };

    const down = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const editing = target instanceof HTMLInputElement && !['checkbox', 'range', 'radio', 'button'].includes(target.type) ||
        target instanceof HTMLTextAreaElement || !!target?.isContentEditable;
      const profile = phoneAction(event);
      const dedicated = phoneMenuAction(event);
      if (editing && event.code !== 'Escape' && !profile && !dedicated) return;
      const always = dedicated ?? (event.code === 'KeyM' ? 'menu' : event.code === 'Escape' ? 'back' : undefined);
      if (event.repeat) {
        if (keys.has(event.code)) event.preventDefault();
        return;
      }
      if (keys.has(event.code)) return;
      keys.add(event.code);

      if (always) { event.preventDefault(); current.current.onUi(always); return; }
      if (current.current.gameplay) {
        if (profile === 'pound') {
          event.preventDefault();
          clearPound();
          pound = { code: event.code, used: false, timer: setTimeout(() => {
            if (!pound || !current.current.gameplay) return;
            pound.used = true;
            current.current.onUi('menu');
          }, 650) };
        } else input.onKeyDown(event);
      } else {
        const logical = profile ?? input.actionForKeyboard(event.code) ?? undefined;
        const key = event.code === 'Backspace' ? 'back' : logical && (uiKey[logical] ?? logical);
        if (key) { event.preventDefault(); current.current.onUi(key); }
      }
    };

    const up = (event: KeyboardEvent) => {
      keys.delete(event.code);
      if (pound?.code === event.code) {
        if (!pound.used && current.current.gameplay) {
          input.press('phone:pound', 'pound');
          input.release('phone:pound');
        }
        clearPound();
        event.preventDefault();
      }
      input.onKeyUp(event);
    };

    const suspended = () => { keys.clear(); clearPound(); input.releaseAll(); };
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
