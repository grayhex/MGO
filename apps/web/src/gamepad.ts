import { ACTIONS, type Action, type InputController } from './input';
export type PadAction = Action | 'ui:menu' | 'ui:back' | 'ui:fullscreen' | 'ui:lights';
export type PadBinding = { kind: 'button'; index: number } | { kind: 'axis'; index: number; direction: -1 | 1 };
export interface PadProfile { deadzone: number; bindings: Partial<Record<PadAction, PadBinding[]>> }
export interface PadState { controllers: { id: string; index: number; mapping: string }[]; pressed: string[] }
export const PAD_ACTIONS: PadAction[] = [...ACTIONS, 'ui:menu', 'ui:back', 'ui:fullscreen', 'ui:lights'];
const button = (index: number): PadBinding => ({ kind: 'button', index });
const axis = (index: number, direction: -1 | 1): PadBinding => ({ kind: 'axis', index, direction });
export const DEFAULT_PAD: PadProfile = { deadzone: .35, bindings: {
  up: [axis(1,-1)], down: [axis(1,1)], left: [axis(0,-1)], right: [axis(0,1)],
  d2: [button(12)], d8: [button(13)], d4: [button(14)], d6: [button(15)], d5: [button(0)], fire: [button(2)],
  softLeft: [button(4)], softRight: [button(5), button(1)], star: [button(6)], pound: [button(7)], 'ui:menu': [button(9)], 'ui:back': [button(8)],
} };
export const PAD_NAVIGATION: Partial<Record<PadAction, Action>> = { d2: 'up', d4: 'left', d5: 'fire', d6: 'right', d8: 'down' };
export function sanitizeProfile(raw: unknown): PadProfile {
  const p = raw as Partial<PadProfile> | null;
  const bindings: PadProfile['bindings'] = {};
  for (const action of PAD_ACTIONS) {
    const entries = p?.bindings?.[action]; if (!Array.isArray(entries)) continue;
    bindings[action] = entries.filter((b) => Number.isInteger(b?.index) && b.index >= 0 && b.index < 128 && (b.kind === 'button' || (b.kind === 'axis' && (b.direction === 1 || b.direction === -1))));
  }
  return { deadzone: Math.min(.9, Math.max(.1, typeof p?.deadzone === 'number' && Number.isFinite(p.deadzone) ? p.deadzone : .35)), bindings };
}
const key = (game?: string) => `j2me-web.gamepad.v1${game ? ':' + game : ''}`;
export function loadPadProfile(game?: string): PadProfile {
  try { const raw = localStorage.getItem(key(game)); if (raw) return sanitizeProfile(JSON.parse(raw)); } catch { /* fallback */ }
  if (game) return loadPadProfile();
  return structuredClone(DEFAULT_PAD);
}
export function savePadProfile(p: PadProfile, game?: string): void { try { localStorage.setItem(key(game), JSON.stringify(sanitizeProfile(p))); } catch { /* unavailable */ } }
export function clearPadOverride(game: string): void { try { localStorage.removeItem(key(game)); } catch { /* unavailable */ } }
export function bindingOn(p: Gamepad, b: PadBinding, deadzone: number): boolean {
  return b.kind === 'button' ? !!(p.buttons[b.index]?.pressed || (p.buttons[b.index]?.value ?? 0) > .5) : (p.axes[b.index] ?? 0) * b.direction > deadzone;
}
/** Manual tick supports deterministic tests. Never holds a key while unfocused or disabled. */
export class GamepadPoller {
  private raf = 0;
  private active = new Map<string, PadAction>();
  private blocked = new Set<string>();
  private heldBindings = new Set<string>();
  private profileBlocked = new Set<string>();
  private suspended = false;
  private pageDirection = 0;
  private nextPageAt = 0;
  private vibration?: { index: number; id: string; actuator: GamepadHapticActuator };
  profile: PadProfile;
  uiMode = false;
  reserveMenu = false;
  onUi?: (action: PadAction) => void;
  onPage?: (direction: -1 | 1) => void;
  onState?: (state: PadState) => void;
  capture?: (binding: PadBinding) => void;
  constructor(private input: InputController, private onName?: (name: string | null) => void, profile = loadPadProfile()) { this.profile = profile; }
  private blur = () => { this.suspended = true; this.stopRumble(); for(const source of this.active.keys())this.blocked.add(source); this.release(); };
  private focus = () => { this.suspended = false; };
  private visibility = () => { if (document.hidden) this.blur(); else this.focus(); };
  release(): void { for (const source of this.active.keys()) this.input.release(source); this.active.clear(); }
  setUiMode(uiMode: boolean): void {
    if (this.uiMode === uiMode) return;
    for (const source of this.active.keys()) this.blocked.add(source);
    this.release();
    this.uiMode = uiMode;
  }
  setProfile(profile: PadProfile): void {
    // A card and its library can select different profiles while Back is still held.
    for (const binding of this.heldBindings) this.profileBlocked.add(binding);
    this.release();
    this.profile = sanitizeProfile(profile);
  }
  rumble(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) { this.stopRumble(); return; }
    if (this.suspended || document.hidden || !document.hasFocus()) return;
    const pad = [...(navigator.getGamepads?.() ?? [])].find(p => p?.connected && typeof p.vibrationActuator?.playEffect === 'function');
    if (!pad) return;
    if (this.vibration?.index !== pad.index || this.vibration.id !== pad.id) this.stopRumble();
    const actuator = pad.vibrationActuator;
    this.vibration = { index: pad.index, id: pad.id, actuator };
    // Browsers can reject haptics when the controller is disconnected or the document loses focus.
    void actuator.playEffect('dual-rumble', { duration: Math.min(ms, 2000), strongMagnitude: .7, weakMagnitude: .45 }).catch(() => undefined);
  }
  stopRumble(): void {
    const actuator = this.vibration?.actuator;
    this.vibration = undefined;
    void actuator?.reset?.().catch(() => undefined);
  }
  tick(pads: readonly (Gamepad | null)[], focused = true): void {
    const capturing=!!this.capture; const now = new Map<string, PadAction>(); const present = new Set<string>();
    const bindings = new Set<string>();
    const page = this.uiMode && focused && !this.suspended && !capturing ? this.onPage : undefined;
    let pageDirection: -1 | 0 | 1 = 0;
    const controllers = pads.filter((p): p is Gamepad => !!p?.connected).map((p) => ({ id:p.id,index:p.index,mapping:p.mapping }));
    if (this.vibration && (!focused || !controllers.some(p => p.index === this.vibration?.index && p.id === this.vibration.id))) this.stopRumble();
    this.onName?.(controllers[0]?.id ?? null);
    for (const p of pads) {
      if (!p?.connected) continue;
      const rightY = p.mapping === 'standard' ? p.axes[3] ?? 0 : 0;
      if (page && !pageDirection && Math.abs(rightY) >= Math.max(.65, this.profile.deadzone)) pageDirection = rightY < 0 ? -1 : 1;
      const found: PadBinding[] = [];
      p.buttons.forEach((b,i) => { if(b.pressed || b.value > .5) found.push(button(i)); });
      p.axes.forEach((a,i) => { if(Math.abs(a) > Math.max(.6,this.profile.deadzone)) found.push(axis(i,a < 0 ? -1 : 1)); });
      if (this.capture && found[0] && focused && !this.suspended) { const cb=this.capture; this.capture=undefined; cb(found[0]); this.release(); }
      for (const action of PAD_ACTIONS) for (const b of this.profile.bindings[action] ?? []) {
        const source=`pad:${p.index}:${action}:${b.kind}:${b.index}:${b.kind === 'axis' ? b.direction : ''}`;
        if (!bindingOn(p,b,this.profile.deadzone)) continue;
        const physical = `${p.index}:${b.kind}:${b.index}:${b.kind === 'axis' ? b.direction : ''}`;
        bindings.add(physical);
        present.add(source);
        if (!focused || this.suspended || (!this.input.enabled && !this.uiMode) || capturing) { this.blocked.add(source); continue; }
        if (!this.blocked.has(source) && !this.profileBlocked.has(physical)) now.set(source,action);
      }
    }
    this.heldBindings = bindings;
    for (const binding of this.profileBlocked) if (!bindings.has(binding)) this.profileBlocked.delete(binding);
    for(const source of this.blocked) if(!present.has(source)) this.blocked.delete(source);
    if (this.reserveMenu && [...now].some(([source, action]) => (action === 'ui:menu' || action === 'ui:back') && !this.active.has(source))) {
      for (const [source, action] of now) {
        if (action.startsWith('ui:')) continue;
        now.delete(source);
        this.blocked.add(source);
      }
    }
    for (const source of this.active.keys()) if (!now.has(source)) this.input.release(source);
    for (const [source,action] of now) {
      if (action.startsWith('ui:') || this.uiMode) {
        this.input.release(source);
        if (!this.active.has(source)) this.onUi?.(action);
      } else if (this.input.enabled) this.input.press(source,action as Action);
    }
    this.active=now;
    if (page && pageDirection) {
      const time = performance.now();
      if (pageDirection !== this.pageDirection || time >= this.nextPageAt) {
        page(pageDirection);
        this.nextPageAt = time + 320;
      }
    }
    this.pageDirection = pageDirection;
    this.onState?.({controllers,pressed:[...new Set(now.values())]});
  }
  start(): void {
    window.addEventListener('blur',this.blur); window.addEventListener('focus',this.focus); document.addEventListener('visibilitychange',this.visibility);
    const run=()=>{ this.tick(navigator.getGamepads?.() ?? [], document.hasFocus() && !document.hidden);this.raf=requestAnimationFrame(run); };
    this.raf=requestAnimationFrame(run);
  }
  stop(): void { cancelAnimationFrame(this.raf);window.removeEventListener('blur',this.blur);window.removeEventListener('focus',this.focus);document.removeEventListener('visibilitychange',this.visibility);this.stopRumble();this.release(); }
}
