import { EMULATION_DEFAULTS, EMULATION_LIMITS, type EmulationTweaks } from '@mgo/protocol';
import { t as translateUI } from '../i18n';
import { Hint, Switch } from './ui';

type Size = 'small' | 'medium' | 'large';

/**
 * The per-game options that change what the game sees (see EmulationTweaks). An empty field means "the emulator's
 * default", which is shown as the placeholder; nothing here is stored unless the user changes it.
 */
export function EmulationTweaksForm({ value, onChange, pointerDefault, fullscreenDefault }: { value: EmulationTweaks; onChange: (v: EmulationTweaks) => void; pointerDefault: boolean; fullscreenDefault: boolean }) {
  const set = (patch: Partial<EmulationTweaks>) => {
    const next: EmulationTweaks = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof EmulationTweaks)[]) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  const resettable = [value.locale, value.pointerEvents, value.forceFullscreen, value.startAppOnResume, value.preloadResources].some(v => v !== undefined);
  return (
    <fieldset className="tweaks">
      <label className="control-line tweak-locale">
        <span className="label-caps">{translateUI('Locale')} <Hint text="What the game reads as microedition.locale, for example en-US or ru-RU. Some games pick their language from it." /></span>
        <input className="input" type="text" maxLength={8} placeholder={EMULATION_DEFAULTS.locale} value={value.locale ?? ''}
          onChange={(e) => set({ locale: e.target.value === '' ? undefined : e.target.value })} aria-label={translateUI('Language of the phone')} />
      </label>
      <div className="tweak-switches">
        <div className="control-line">
          <Switch checked={value.pointerEvents ?? pointerDefault} onChange={(v) => set({ pointerEvents: v === pointerDefault ? undefined : v })}>{translateUI('Touch events')}</Switch>
          <Hint text="Tell the game the phone has a touch screen" />
        </div>
        <div className="control-line">
          <Switch checked={value.startAppOnResume ?? EMULATION_DEFAULTS.startAppOnResume} onChange={(v) => set({ startAppOnResume: v === EMULATION_DEFAULTS.startAppOnResume ? undefined : v })}>{translateUI('Pause callbacks')}</Switch>
          <Hint text="Call pauseApp and startApp when the game is paused and resumed" />
        </div>
        <div className="control-line">
          <Switch checked={value.preloadResources ?? false} onChange={on => set({ preloadResources: on || undefined })}>{translateUI('Preload resources')}</Switch>
          <Hint text="KEmulator v2.22.1 and later. Uses more memory to load game resources at startup." />
        </div>
        <div className="control-line">
          <Switch checked={value.forceFullscreen ?? fullscreenDefault} onChange={forceFullscreen => set({ forceFullscreen })}>{translateUI('Game fullscreen')}</Switch>
          <Hint text="Force the game canvas to use the whole emulated screen, including the area normally reserved for soft keys. Applies on restart." />
        </div>
      </div>
      <div className="btn-row">
        <button className="btn ghost sm" disabled={!resettable} onClick={() => set({ locale: undefined, pointerEvents: undefined, startAppOnResume: undefined, preloadResources: undefined, forceFullscreen: undefined })}>{translateUI('Reset options')}</button>
        <Hint text="Applied when the game is started the next time." />
      </div>
    </fieldset>
  );
}

export function GameFontSizes({ value, onChange }: { value?: EmulationTweaks['fontSizes']; onChange: (sizes: EmulationTweaks['fontSizes']) => void }) {
  const fonts = value ?? EMULATION_DEFAULTS.fontSizes;
  const [min, max] = EMULATION_LIMITS.fontSize;
  const setFont = (size: Size, raw: string) => {
    const input = Math.round(Number(raw));
    if (raw && Number.isFinite(input)) onChange({ ...fonts, [size]: Math.min(max, Math.max(min, input)) });
  };
  return <div className="field">
    <span className="label-caps">{translateUI('Font sizes (px)')}</span>
    <div className="field-row three">
      {(['small', 'medium', 'large'] as const).map(size =>
        <input key={size} className="input" type="number" min={min} max={max} value={fonts[size]} onChange={e => setFont(size, e.target.value)} aria-label={translateUI(`Font size ${size}`)} />)}
    </div>
    <button className="btn sm ghost" type="button" disabled={!value} onClick={() => onChange(undefined)}>{translateUI('Reset font sizes')}</button>
  </div>;
}
