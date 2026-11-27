// Real API + KEmulator + Chromium. Gamepad and phone HID input are simulated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'mgo-features-')),port=19800+Math.floor(Math.random()*300),base=`http://127.0.0.1:${port}`;
const server=spawn('node',['apps/api/dist/server.js'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,HOST:'127.0.0.1',LOG_LEVEL:'warn'},stdio:['ignore','inherit','inherit']});
let browser;
const wait=async(fn)=>{for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('readiness timeout');};
try {
 await wait(async()=> (await fetch(base+'/api/health')).ok);
await fetch(base + '/api/setup/skip', { method: 'POST' }); // the first-run wizard is covered by setup.mjs
 const fd=new FormData();fd.append('jar',new Blob([readFileSync('tests/fixtures/testmidlet/build/kemtest.jar')]),'kemtest.jar');
 const upload=await fetch(base+'/api/games',{method:'POST',body:fd});assert.equal(upload.status,201);const game=(await upload.json()).game;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox']});
 const p=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(() => {
   window.padButtons = [];
   window.padConnected = true;
   window.padEffects = [];
   window.padResets = 0;
   const vibrationActuator = {
     playEffect: async (effect, params) => { window.padEffects.push({ effect, ...params }); return 'complete'; },
     reset: async () => { window.padResets++; return 'complete'; },
   };
   Object.defineProperty(navigator, 'getGamepads', { value: () => window.padConnected ? [{
     index: 0, id: 'Simulated Xbox standard', connected: true, mapping: 'standard', timestamp: performance.now(),
     axes: [0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: window.padButtons.includes(i), value: window.padButtons.includes(i) ? 1 : 0 })),
     vibrationActuator,
   }] : [] });
 });
 // the phones are chosen on /phones (the player has no picker): a click sets the phone of the game opened last
 const choosePhone=async(re)=>{await p.getByTestId('current-game').waitFor();await p.getByRole('link',{name:'Phones'}).click();await p.getByRole('button',{name:re}).click();await p.waitForURL('**/play/'+game.id,{waitUntil:'commit'});};
 await p.goto(base+'/play/'+game.id);
 await choosePhone(/6100/);
 await p.waitForFunction(()=>document.querySelector('[aria-label="Device preset"]').value==='128x128-common-full-screen');
 await p.locator('.ctrl-col').getByRole('button',{name:'Start',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('[data-testid=state-badge]').textContent.includes('running'));
 const sessions=async()=>await(await fetch(base+'/api/sessions')).json();const sid=(await sessions())[0].id;
 await choosePhone(/E71/);
 await p.getByRole('button',{name:'Restart with selected profile'}).waitFor();
 assert.equal((await sessions())[0].id,sid);assert.equal((await sessions())[0].width,128);
 await p.getByRole('button',{name:'Restart with selected profile'}).click();
 await wait(async()=> (await sessions()).some(s=>s.state==='running'&&s.width===320));
 await p.getByText('Advanced profile',{exact:true}).click();
 await p.getByLabel('Device preset',{exact:true}).selectOption('132x176-siemens-full-screen');
 await wait(async()=>{const games=await(await fetch(base+'/api/games')).json();return games.find(g=>g.id===game.id).settings.device==='132x176-siemens-full-screen';}); // saved before leaving for /phones
 await choosePhone(/K750i/);
 await p.waitForFunction(()=>document.querySelector('[aria-label="Device preset"]')?.value==='132x176-siemens-full-screen'); // the advanced profile survives the trip to /phones
 await wait(async()=>{const games=await(await fetch(base+'/api/games')).json();const s=games.find(g=>g.id===game.id).settings;return s.skinId==='sony-ericsson-k750i'&&s.profileMode==='advanced'&&s.device==='132x176-siemens-full-screen';});
 await p.getByRole('radio',{name:/Screen/}).click();
 const keypad = p.getByTestId('phone-keypad');
 await keypad.waitFor();
 const column = p.locator('.stage-foot.side');
 const maxWidth = (await column.boundingBox()).width;
 const widths = p.getByRole('radiogroup', { name: 'Keypad width', exact: true });
 for (const [label, scale] of [['150%', .75], ['100%', .5]]) {
   await widths.getByRole('radio', { name: label }).click();
   assert.ok(Math.abs((await column.boundingBox()).width - maxWidth * scale) < 2, `the ${label} keypad width applies`);
 }
 const keypadToggle = p.getByRole('checkbox', { name: 'On-screen keypad', exact: true });
 const keypadLabel = p.locator('label.switch').filter({ hasText: 'On-screen keypad' });
 await keypadLabel.click();
 assert.equal(await keypadToggle.isChecked(), false);
 await keypad.waitFor({ state: 'hidden' });
 await keypadLabel.click();
 await keypad.waitFor();
 await p.getByRole('radio', { name: 'Phone', exact: true }).click();
 assert.ok(await keypadToggle.isDisabled() && !await keypadToggle.isChecked());
 await keypad.waitFor({ state: 'hidden' });
 await p.getByRole('radio', { name: 'Screen', exact: true }).click();
 assert.ok(await keypadToggle.isEnabled() && await keypadToggle.isChecked(), 'Screen view restores the chosen keypad preference');
 await keypad.waitFor();
 await p.evaluate(()=>window.originalCanvas=document.querySelector('.skin-canvas'));
 await p.getByRole('button',{name:'Lights Out',exact:true}).click();
 await p.locator('.lights-out').waitFor();
 assert.equal(await p.evaluate(()=>document.querySelector('.skin-canvas')===window.originalCanvas),true);
 const beforeFrames=(await sessions()).find(s=>s.state==='running').framesReceived;
 await wait(async()=> (await sessions()).find(s=>s.state==='running').framesReceived > beforeFrames+2);
 const style=await p.locator('.skin-canvas').evaluate(c=>({opacity:getComputedStyle(c).opacity,filter:getComputedStyle(c).filter,w:c.width,h:c.height}));
 assert.equal(style.opacity,'1');assert.equal(style.filter,'none');assert.deepEqual([style.w,style.h],[320,240]);
 await p.keyboard.press('Digit5');
 await wait(async()=>{const s=(await sessions()).find(s=>s.state==='running');return (await(await fetch(base+'/api/sessions/'+s.id)).json()).logTail.some(l=>l.includes('KEY_DOWN 53'));});
 await p.evaluate(()=>window.padButtons=[2]);
 await wait(async()=>{const s=(await sessions()).find(s=>s.state==='running');return (await(await fetch(base+'/api/sessions/'+s.id)).json()).logTail.some(l=>l.includes('KEY_DOWN -5'));});
 await p.evaluate(()=>window.padButtons=[]);
 const running=(await sessions()).find(s=>s.state==='running').id;
 await p.reload();await p.locator('.lights-out').waitFor();
 assert.equal((await sessions()).find(s=>s.state==='running').id,running);
 await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('.lights-out'));
 assert.equal(await widths.getByRole('radio', { name: '100%' }).getAttribute('aria-checked'), 'true', 'the keypad width survives a reload');
 await p.keyboard.press('Alt+KeyL');await p.locator('.lights-out').waitFor();
 const lights = p.getByRole('group', { name: 'Lights Out controls' });
 const exitLights = lights.getByRole('button', { name: 'Exit Lights Out' });
 const lightsKeypad = lights.getByRole('button', { name: 'On-screen keypad' });
 assert.equal(await lights.getByRole('button').count(), 3);
 await lightsKeypad.click();
 assert.equal(await lightsKeypad.getAttribute('aria-pressed'), 'true');
 await keypad.waitFor();
 await lightsKeypad.click();
 await keypad.waitFor({ state: 'hidden' });
 await exitLights.click();
 await p.keyboard.press('Alt+KeyL');await p.locator('.lights-out').waitFor();
 await lights.getByRole('button', { name: 'Fullscreen', exact: true }).click();
 await p.waitForFunction(()=>!!document.fullscreenElement);
 // in fullscreen the button still sits in the top-right corner of the screen
 const corner=await lights.evaluate(e=>{const r=e.getBoundingClientRect();return {right:innerWidth-r.right,top:r.top};});
 assert.ok(corner.right>=8&&corner.right<=24&&corner.top>=8&&corner.top<=24,'Controls sit in the corner: '+JSON.stringify(corner));
 await exitLights.click();
 await p.evaluate(()=>document.exitFullscreen());
 // The standard A button sends keypad 5 to the real game.
 await p.evaluate(()=>window.padButtons=[0]);
 await wait(async()=>{const s=(await sessions()).find(s=>s.state==='running');return (await(await fetch(base+'/api/sessions/'+s.id)).json()).logTail.some(l=>l.includes('KEY_DOWN 53'));});
 await p.evaluate(()=>window.padButtons=[]);
 const padSettings = p.getByRole('button', {name:'Gamepad settings / UI navigation'});
 const pressPad = async button => {
   await p.evaluate(async n => { window.padButtons = [n]; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, button);
   await p.evaluate(async () => { window.padButtons = []; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
 };
 const presses = async code => (await fetch(base + '/api/sessions/' + running).then(r => r.json())).logTail.filter(line => line.includes(`KEY_DOWN ${code}`)).length;
 const fiveBefore = await presses(53);
 await p.evaluate(() => { window.focusBeforeMenu = document.activeElement; });
 await pressPad(9);
 assert.equal(await padSettings.getAttribute('aria-expanded'), 'false', 'Menu cannot open UI navigation during gameplay');
 assert.equal(await p.evaluate(() => document.activeElement === window.focusBeforeMenu), true, 'Menu keeps the current focus');
 await pressPad(0);
 await wait(async() => (await presses(53)) > fiveBefore);
 await padSettings.click();
 const fireWithSettings = await presses(-5);
 const key = await keypad.locator('polygon[data-action="fire"]').first().boundingBox();
 assert.ok(key);
 await p.mouse.click(key.x + key.width / 2, key.y + key.height / 2);
 await wait(async () => (await presses(-5)) > fireWithSettings);
 await p.locator('.pad-binding').filter({hasText:'D-pad up'}).locator('button').first().click();
 await p.evaluate(()=>window.padButtons=[6]);await p.waitForFunction(()=>document.querySelector('.pad-binding').textContent.includes('B6'));
 await p.evaluate(()=>window.padButtons=[]);await p.getByRole('button',{name:'Save mapping',exact:true}).click();
 assert.equal(await p.evaluate(id=>JSON.parse(localStorage.getItem('j2me-web.gamepad.v1:'+id)).bindings.up[0].index,game.id),6);
 await pressPad(9);
 assert.equal(await padSettings.getAttribute('aria-expanded'), 'false');
 assert.equal(await p.evaluate(() => document.activeElement.classList.contains('stage')), true, 'closing settings returns focus to the game');
 const keyboardBefore = await presses(53);
 await p.keyboard.press('Digit5');
 await wait(async () => (await presses(53)) > keyboardBefore);
 const keyboardIcon = p.getByRole('img', { name: 'Input: Keyboard' });
 const padIcon = p.getByRole('img', { name: 'Gamepad connected' });
 const phoneIcon = p.getByRole('img', { name: 'Sony Ericsson HID input detected' });
 assert.equal(await keyboardIcon.getAttribute('data-active'), 'true');
 await padIcon.waitFor();
 await phoneIcon.waitFor({ state: 'hidden' });
 const identifyPhone = () => p.keyboard.press('Control+Alt+Shift+KeyP');
 await identifyPhone();
 await phoneIcon.waitFor();
 assert.equal(await phoneIcon.getAttribute('data-active'), 'true');
 assert.equal(await padIcon.textContent(), 'Gamepad');
 assert.equal(await phoneIcon.textContent(), 'SE');
 for (const [physical, code] of [['ArrowUp', -1], ['ArrowLeft', -3], ['ArrowRight', -4], ['Enter', -5], ['Digit9', 57]]) {
   const before = await presses(code);
   await p.keyboard.press(physical);
   await wait(async () => (await presses(code)) > before);
 }
 assert.equal(await p.locator('.lights-out').count(), 0);
 assert.equal(await phoneIcon.isVisible(), true, 'ordinary keyboard events do not hide the phone badge');
 assert.equal(await padIcon.isVisible(), true);
 await pressPad(0);
 assert.equal(await padIcon.getAttribute('data-active'), 'true');
 assert.equal(await phoneIcon.getAttribute('data-active'), 'false');
 await p.evaluate(() => { window.padConnected = false; });
 await padIcon.waitFor({ state: 'hidden' });
 await phoneIcon.waitFor();
 await p.evaluate(() => { window.padConnected = true; });
 const volume = p.getByRole('slider', { name: 'Volume' });
 assert.deepEqual(await p.locator('.volume-ticks span').allTextContents(), ['0%', '25%', '50%', '75%', '100%']);
 await volume.fill('61');
 assert.equal(await volume.getAttribute('aria-valuetext'), '61%');
 assert.deepEqual(errors,[]);
 console.log('PASS: automatic profile, pending restart, Advanced persistence, unchanged LCD/Canvas/session in Lights Out, Escape/Alt+L, keyboard, simulated gamepad + rebind/save.');
 // Mobile layout, persisted presentation only; does not start/restart the game.
 await p.setViewportSize({width:390,height:844});await p.keyboard.press('Alt+KeyL');await p.locator('.lights-out').waitFor();
 assert.ok(await exitLights.isVisible());
 assert.equal((await sessions()).find(s=>s.state==='running').id,running);
 console.log('PASS: mobile exit remains visible.');

 await p.setViewportSize({ width: 1440, height: 1000 });
 await fetch(base + '/api/sessions/' + running, { method: 'DELETE' });
 const net = new FormData();
 net.append('jar', new Blob([readFileSync('tests/fixtures/labgames/build/kemnet.jar')]), 'kemnet.jar');
 const netUpload = await fetch(base + '/api/games', { method: 'POST', body: net });
 assert.equal(netUpload.status, 201);
 await p.goto(base + '/play/' + (await netUpload.json()).game.id);
 await p.locator('.player-grid').waitFor();
 if (await p.locator('.lights-out').count()) await p.keyboard.press('Escape');
 await p.locator('.ctrl-col').getByRole('button', { name: 'Start', exact: true }).click();
 await p.waitForFunction(() => document.querySelector('[data-testid=state-badge]').textContent.includes('running'));
 const deny = p.getByRole('button', { name: 'Deny', exact: true });
 await deny.waitFor({ timeout: 2500 }).then(() => deny.click(), () => undefined);
 await p.keyboard.press('Digit1');
 await p.waitForFunction(() => window.padEffects.some(effect => effect.effect === 'dual-rumble' && effect.duration === 300));
 const effects = await p.evaluate(() => window.padEffects.length);
 await p.locator('label.switch').filter({ hasText: 'Gamepad vibration' }).click();
 await p.waitForFunction(() => window.padResets > 0);
 await p.locator('.skin-canvas').click();
 await p.keyboard.press('Digit1');
 await wait(async () => {
   const running = (await sessions()).find(session => session.state === 'running');
   const status = await (await fetch(base + '/api/sessions/' + running.id)).json();
   return status.logTail.filter(line => line.includes('VIBRATE_REQUESTED')).length >= 2;
 });
 assert.equal(await p.evaluate(() => window.padEffects.length), effects, 'a real Java ME vibrate request is ignored when gamepad vibration is off');
 assert.deepEqual(errors, []);
 console.log('PASS: Java ME vibration reaches the gamepad and the control can switch it off.');
 await p.goto(base + '/settings#sound');
 await p.getByText('Bluetooth phone · Sony Ericsson', { exact: true }).click();
 for (const [model, name] of [['K790i', 'MGO790A2'], ['K750i', 'MGO750A2'], ['W995', 'MGO995A2']]) {
   const ready = p.waitForEvent('download');
   await p.getByRole('link', { name: `Download ${model} .hid profile` }).click();
   const download = await ready;
   assert.equal(download.suggestedFilename(), `${name}.hid`);
   assert.equal(readFileSync(await download.path()).toString('ascii', 257, 262), 'ustar');
 }
 await p.getByRole('button', { name: 'Test phone buttons' }).click();
 await p.keyboard.press('ArrowUp');
 await p.getByText('Received D-pad up', { exact: true }).waitFor();
 await identifyPhone();
 await p.getByText('Sony Ericsson HID input detected', { exact: true }).waitFor();
 console.log('PASS: Bluetooth profile download and tester, phone keys reach KEmulator, and input icons follow each device.');
} finally {await browser?.close();server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));rmSync(dir,{recursive:true,force:true});}
