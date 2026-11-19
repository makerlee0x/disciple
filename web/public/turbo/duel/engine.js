/* DISCIPLE Trading Duel screen, ported from the signed-off prototype (https://claude.ai/artifact/SbjfezPzV3PLWMi7qkPMWu). Edit this file directly.
 * window.DuelEngine.mount(root, host) \u2192 api. The host does every server call; see components/turbo/duel/DuelScreen.tsx. */
(function(){
/* Ranked / Unranked pill (maker 2026-11-18) */
const RK=(on)=>on?'<em class="rk on">RANKED</em>':'<em class="rk un">UNRANKED</em>';
const CSS=".duel-root .acount.pwait{animation:pwPulse 1.1s ease-in-out infinite;letter-spacing:.08em}@keyframes pwPulse{0%,100%{opacity:.3}50%{opacity:1}}.duel-root .arena .avid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:0;transition:opacity .5s ease;pointer-events:none}.duel-root .arena.vid .avid{opacity:1}.duel-root .arena.vid .art{visibility:hidden}.duel-root .rvid{position:fixed;inset:0;z-index:58;width:100%;height:100%;object-fit:cover;pointer-events:none;background:#07080c}.duel-root .rvid.dim{filter:brightness(.45) blur(2px);transition:filter .6s ease}.duel-root #result{z-index:59}.duel-root .nvid{position:absolute;z-index:6;width:min(80vmin,620px);height:min(80vmin,620px);transform:translate(-50%,-50%);mix-blend-mode:screen;pointer-events:none}\n.duel-root .app.embed,.duel-root .app.embed.big{--ch:64px}.duel-root .app.embed .feed,.duel-root .app.embed .size,.duel-root .app.embed .chatb{display:none!important}.duel-root .app.embed .boost,.duel-root .app.embed .dump{height:58px}\n.duel-root .sline{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:10px;padding:10px 14px;border-radius:14px;background:rgba(242,193,78,.08);border:1px solid rgba(242,193,78,.35);font:700 15px/1.2 var(--f-game);letter-spacing:.4px;text-transform:uppercase}.duel-root .sline i{font-style:normal;color:var(--muted)}.duel-root .sline .up{color:var(--green)}.duel-root .sline .dn{color:var(--pinkl)}.duel-root .sline .fire{color:#FFB48F}\n.duel-root .xlink{display:flex;align-items:center;gap:10px;margin-top:10px;padding:12px 14px;border-radius:14px;border:1px solid rgba(95,240,160,.45);background:rgba(95,240,160,.08);color:var(--text);text-decoration:none;font:600 15px/1.25 var(--f-ui,system-ui,sans-serif)}.duel-root .xlink span{flex:1;min-width:0;font-size:14px}.duel-root .xlink b{white-space:nowrap;color:var(--green);font-family:var(--f-game);font-size:18px;letter-spacing:.3px}.duel-root .xlink em{margin-left:auto;font-style:normal;color:var(--gold);font-family:var(--f-game);font-size:17px;white-space:nowrap}\n.duel-root{\n  --night:#0B0C0E; --ink:#121327; --glass:rgba(18,19,39,.82); --line:rgba(255,255,255,.22);\n  --text:#F2F3F7; --muted:rgba(215,217,228,.85); --gold:#F2C14E; --champ:#F3DFA8; --green:#5FF0A0; --pink:#F0307F; --pinkl:#FF8FBD;\n  --f-game:var(--font-barlow-condensed),'Barlow Condensed','Arial Narrow',system-ui,sans-serif; --f-ui:var(--font-geist),'Geist',system-ui,-apple-system,sans-serif;\n  color-scheme:dark;\n}\n.duel-root *{box-sizing:border-box}\n.duel-root,.duel-root{height:100%;margin:0;background:#07080c}\n.duel-root{color:var(--text);font-family:var(--f-ui);overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}\n.duel-root [hidden]{display:none!important}.duel-root .ctl>button.coached{position:relative;overflow:visible;z-index:3;box-shadow:0 0 0 3px rgba(243,223,168,.9),0 0 26px rgba(243,223,168,.45)}.duel-root .coachf{position:absolute;left:50%;top:58%;width:40px;height:48px;margin-left:-12px;pointer-events:none;animation:cfTap 1.1s ease-in-out infinite;filter:drop-shadow(0 4px 10px rgba(0,0,0,.6))}.duel-root .coachb{position:absolute;left:50%;bottom:calc(100% + 66px);transform:translateX(-50%);white-space:nowrap;pointer-events:none;padding:8px 12px;border-radius:12px;background:rgba(18,19,39,.94);border:1px solid rgba(243,223,168,.6);box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;align-items:center;gap:3px}.duel-root .coachb b{font:800 18px/1 var(--f-game);color:var(--champ);letter-spacing:.3px}.duel-root .coachb small{font:500 12px/1 var(--f-ui);color:var(--muted)}.duel-root #bBoost .coachb{left:0;transform:none}.duel-root #bDump .coachb{left:auto;right:0;transform:none}@keyframes cfTap{0%,100%{transform:translate(6px,10px) scale(1)}45%{transform:translate(0,0) scale(.9)}55%{transform:translate(0,0) scale(.86)}}@media (prefers-reduced-motion:reduce){.duel-root .coachf{animation:none}}.duel-root .fcrate{display:flex;align-items:center;gap:14px;margin:12px 0 4px;padding:10px 14px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid var(--line);text-align:left}.duel-root .fc-box{position:relative;width:84px;height:84px;flex:none}.duel-root .fc-box img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.duel-root .fcrate.drop #rCrateImg{animation:fcDrop .7s cubic-bezier(.3,1.5,.5,1) both}.duel-root .fcrate.open #rCrateImg{animation:fcOut .35s ease-in both}.duel-root .fcrate.open #rCrateItem{animation:fcPop .5s cubic-bezier(.3,1.6,.5,1) both;filter:drop-shadow(0 0 14px var(--fc))}.duel-root .fc-t{display:flex;flex-direction:column;gap:2px;min-width:0}.duel-root .fc-t small{font:800 12px/1 var(--f-game);letter-spacing:.8px;color:var(--champ)}.duel-root .fc-t b{font:italic 800 24px/1 var(--f-game);text-transform:uppercase;color:var(--fc,var(--text))}.duel-root .fc-t span{font-size:13px;color:var(--muted)}@keyframes fcDrop{0%{transform:translateY(-160px) rotate(-8deg);opacity:0}60%{opacity:1}100%{transform:none;opacity:1}}@keyframes fcOut{to{transform:scale(1.25);opacity:0}}@keyframes fcPop{0%{transform:scale(.2);opacity:0}100%{transform:none;opacity:1}}@media (prefers-reduced-motion:reduce){.duel-root .fcrate *{animation:none!important}}\n.duel-root button{font:inherit;color:inherit;cursor:pointer}\n.duel-root .stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}\n.duel-root .app{position:relative;width:100%;height:100%;overflow:hidden;background:var(--ink);--ch:176px}\n.duel-root .app.big{--ch:290px}\n@media (min-width:560px){.duel-root .app{width:400px;height:min(100%,860px);border-radius:36px;box-shadow:0 0 0 10px #1b1c22,0 30px 80px rgba(0,0,0,.6)}}\n.duel-root #sky{position:absolute;inset:0;width:100%;height:100%;display:block}\n.duel-root .sb{position:absolute;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;pointer-events:none}\n.duel-root .sb .who{font:700 13px/1 var(--f-game);letter-spacing:.4px;color:var(--champ)}\n.duel-root .sb .who.r{color:var(--muted);text-align:right}\n.duel-root .sb b{display:block;font:800 34px/1 var(--f-game);font-variant-numeric:tabular-nums;text-shadow:0 2px 0 #121327;margin-top:3px}\n.duel-root .sb .r b{text-align:right}\n.duel-root .mid{display:flex;flex-direction:column;align-items:center;gap:4px}\n.duel-root .mid b{font-size:30px;margin:0}\n.duel-root .lead{width:96px;height:8px;border-radius:4px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.4);overflow:hidden;position:relative}\n.duel-root .lead i{position:absolute;top:0;bottom:0;left:50%;background:var(--green);transition:all .25s}\n.duel-root .mid small{font:700 12px/1 var(--f-game);letter-spacing:.4px;color:var(--muted)}\n.duel-root .mid.ot b{color:var(--pinkl)}\n.duel-root .chart{position:absolute;left:12px;right:12px;top:calc(76px + env(safe-area-inset-top,0px));height:var(--ch);border-radius:16px;background:rgba(12,13,28,.80);border:2px solid rgba(255,255,255,.16);overflow:hidden;transition:height .25s ease;padding:0}\n.duel-root .chart canvas{position:absolute;inset:0;width:100%;height:100%}\n.duel-root .chart .lab{position:absolute;left:10px;top:7px;font:700 12px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);pointer-events:none}\n/* the coin, plain on the card (maker 2026-11-17: \"is that btc?\") */\n.duel-root .chart .lab{display:flex;align-items:center;gap:6px;top:6px;white-space:nowrap}\n.duel-root .chart .lab .coin{flex:none;width:18px;height:18px;border-radius:50%;background:#F7931A;color:#fff;font:800 12px/18px var(--f-ui);text-align:center;font-style:normal;box-shadow:0 0 0 1.5px rgba(0,0,0,.35)}\n.duel-root .chart .lab b{font:800 15px/1 var(--f-game);letter-spacing:.6px;color:var(--text)}\n.duel-root .chart .lab em{font-style:normal}\n.duel-root .chart .lab em.up{color:var(--green)}\n.duel-root .chart .lab em.dn{color:var(--pinkl)}\n.duel-root .chatb{top:calc(var(--ch) + 138px + env(safe-area-inset-top,0px))!important}\n.duel-root .chatb .dot{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:var(--pink);border:2px solid #121327}\n.duel-root .chat{position:absolute;right:12px;top:calc(var(--ch) + 190px + env(safe-area-inset-top,0px));width:min(340px,calc(100% - 24px));padding:10px;border-radius:16px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.18);box-shadow:0 12px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:8px;z-index:6}\n.duel-root .chat[hidden]{display:none}\n.duel-root .quick{display:flex;flex-wrap:wrap;gap:6px}\n.duel-root .quick button{height:34px;padding:0 11px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#1d1f2e;color:var(--text);font:800 16px/1 var(--f-game);letter-spacing:.3px}\n.duel-root .quick button:active{transform:scale(.95)}\n.duel-root .say{display:flex;gap:6px}\n.duel-root .say input{flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:#0b0c18;color:var(--text);font:500 16px/1 var(--f-ui);padding:0 10px}\n.duel-root .say button{height:40px;padding:0 14px;border-radius:10px;border:0;background:var(--gold);color:#121327;font:800 17px/1 var(--f-game)}\n.ctools{display:flex;gap:6px;justify-content:space-between}\n.ctools button{height:30px;padding:0 10px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:transparent;color:var(--muted);font:800 14px/1 var(--f-game);letter-spacing:.5px}\n.ctools button.on{color:var(--gold);border-color:rgba(242,193,78,.6)}\n.ctools button.warn{color:#fff;background:var(--pink);border-color:var(--pink)}\n.ctools button:disabled{opacity:.55}\n.ctools button[hidden]{display:none}\n.duel-root .ev.say span b{color:var(--gold)}\n.duel-root .ev.say.them span b{color:var(--pinkl)}\n.duel-root .feed{position:absolute;left:12px;top:calc(var(--ch) + 86px + env(safe-area-inset-top,0px));transition:top .25s ease;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:75%}\n.duel-root .ev{display:flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:999px;background:rgba(18,19,39,.72);border:1px solid rgba(46,50,58,.9);font-size:12px;white-space:nowrap;animation:evin .25s ease-out both;width:max-content}\n.duel-root .ev i{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:800 11px/1 var(--f-game);font-style:normal;color:#121327;flex:none}\n.duel-root .ev b{font:700 13px/1 var(--f-game)}\n@keyframes evin{from{opacity:0;transform:translateX(-12px)}}\n.duel-root .mute{position:absolute;right:12px;top:calc(var(--ch) + 86px + env(safe-area-inset-top,0px));transition:top .25s ease;width:44px;height:44px;border-radius:14px;background:var(--glass);border:2px solid var(--line);display:grid;place-items:center;padding:0}\n.duel-root .bottom{position:absolute;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:8px}\n.duel-root .pos{display:flex;align-items:stretch;gap:8px;border-radius:18px;padding:7px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.22);box-shadow:0 10px 26px rgba(0,0,0,.45);transition:border-color .2s,box-shadow .2s}\n.duel-root .pos small{display:block;font:700 11px/1 var(--f-game);letter-spacing:.7px;color:var(--muted)}\n.duel-root .stkc{width:66px;flex:none;border-radius:12px;background:#23262F;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0}\n.duel-root .stkc b{font:800 22px/1 var(--f-game);color:var(--champ)}\n.duel-root .pi small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.duel-root .pi{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px;padding-left:2px}\n.duel-root .pi b{font:800 26px/1 var(--f-game);font-variant-numeric:tabular-nums;white-space:nowrap}\n.duel-root .pnl{min-width:70px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0 8px;background:#23262F;color:var(--muted)}\n.duel-root .pnl b{font:800 21px/1 var(--f-game);font-variant-numeric:tabular-nums}\n.duel-root .pnl small{color:inherit;font:500 12px/1 var(--f-ui);letter-spacing:0}\n.duel-root .out{width:92px;flex:none;border-radius:12px;background:#F2F3F7;color:#121327;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0}\n.duel-root .out b{font:800 19px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .out small{color:#121327;opacity:.6;font:600 11px/1 var(--f-ui);letter-spacing:0}\n.duel-root .out:disabled{opacity:.25;cursor:default}\n.duel-root .pos.up{border-color:var(--green);box-shadow:0 0 0 3px rgba(95,240,160,.18),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pos.up .pnl{background:var(--green);color:#0d2a1b}\n.duel-root .pos.dn{border-color:var(--pink);box-shadow:0 0 0 3px rgba(240,48,127,.2),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pos.dn .pnl{background:var(--pink);color:#fff}\n.duel-root .row{display:flex;gap:8px}\n.duel-root .ctl{display:flex;gap:8px;align-items:stretch;height:92px}\n.duel-root .size{display:flex;align-items:center;gap:5px;padding:5px 5px 5px 12px;border-radius:14px;background:rgba(12,13,28,.88);border:1px solid rgba(255,255,255,.16)}\n.duel-root .size span{font:700 12px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);margin-right:auto;white-space:nowrap}\n.duel-root .size button{height:34px;min-width:46px;padding:0 8px;border-radius:10px;border:0;background:transparent;font:800 18px/1 var(--f-game);color:var(--text)}\n.duel-root .size button.on{background:var(--champ);color:#121327}\n.duel-root .size button .k{font:500 10px/1 var(--f-ui);opacity:.5;margin-left:3px}\n.duel-root .size.pct button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;height:40px}\n.duel-root .size.pct button .u{margin:0;letter-spacing:0;color:inherit;white-space:nowrap;font:600 11px/1 var(--f-ui);opacity:.65}\n.duel-root .size.pct button.lo{opacity:.35}\n.duel-root .side.off{opacity:.4;filter:saturate(.4)}\n.duel-root .size.pct button.on .u{opacity:.8;color:#121327}\n.duel-root .side{width:98px;flex:none;border-radius:20px;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;line-height:1;transition:transform .08s}\n.duel-root .side:active{transform:scale(.95)}\n.duel-root .side b{font:800 30px/1 var(--f-game)}\n.duel-root .side span{font:800 21px/1 var(--f-game);letter-spacing:1px}\n.duel-root .side small{font:600 12px/1 var(--f-ui);opacity:.8;margin-top:2px}\n.duel-root .side.boost{background:var(--gold);color:#121327;height:auto}\n.duel-root .side.dump{background:var(--pink);color:#fff;height:auto}\n.duel-root .pill{flex:1;min-width:0;border-radius:20px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.22);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0 6px;box-shadow:0 10px 26px rgba(0,0,0,.45);transition:border-color .2s,box-shadow .2s,background .2s}\n.duel-root .pill small{font:700 11px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}\n.duel-root .pill .pv{display:flex;align-items:baseline;gap:6px}\n.duel-root .pill .pv b{font:800 32px/1 var(--f-game);font-variant-numeric:tabular-nums;white-space:nowrap}\n.duel-root .pill .pv em{font:800 22px/1 var(--f-game);font-style:normal;font-variant-numeric:tabular-nums;padding:3px 7px;border-radius:8px}\n.duel-root .pill.up .pv b,.duel-root .pill.dn .pv b{font-size:34px}\n.duel-root .pill .pv{gap:5px}\n@media (max-width:899px){.duel-root .ctl .side{width:84px}\n.duel-root .pill .pv em{font-size:17px;padding:2px 5px}\n.duel-root .pill{padding:0 4px}}\n@media (min-width:900px){.duel-root .pill.up .pv b,.duel-root .pill.dn .pv b{font-size:44px}}\n.duel-root .pill.up .pv b{color:var(--green);text-shadow:0 0 18px rgba(95,240,160,.35)}\n.duel-root .pill.dn .pv b{color:var(--pinkl);text-shadow:0 0 18px rgba(240,48,127,.35)}\n.duel-root .pill.up .pv em{background:rgba(95,240,160,.16)}\n.duel-root .pill.dn .pv em{background:rgba(240,48,127,.18)}\n.duel-root .pill:disabled{cursor:default}\n.duel-root .kh{display:none!important}\n@media (min-width:900px){.duel-root .kh{display:block!important;opacity:.55}}\n.duel-root .pill.up{border-color:var(--green);box-shadow:0 0 0 3px rgba(95,240,160,.18),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pill.up .pv em{color:var(--green)}\n.duel-root .pill.dn{border-color:var(--pink);box-shadow:0 0 0 3px rgba(240,48,127,.2),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pill.dn .pv em{color:var(--pinkl)}\n.duel-root .pill.up #bOutS,.duel-root .pill.dn #bOutS{color:var(--text)}\n.duel-root .pill:not(:disabled):active{transform:scale(.97)}\n.duel-root .btn{flex:1;border-radius:16px;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;transition:transform .08s,filter .15s}\n.duel-root .btn:active{transform:scale(.96)}\n.duel-root .btn:disabled{filter:grayscale(.8) brightness(.6);cursor:default}\n.duel-root .btn b{font:800 24px/1 var(--f-game);letter-spacing:1px}\n.duel-root .btn small{font:600 12px/1 var(--f-ui);margin-top:4px}\n.duel-root .boost{height:66px;background:var(--gold);color:#121327}\n.duel-root .dump{height:66px;background:var(--pink);color:#fff}\n.duel-root .alt{height:48px;background:rgba(18,19,39,.88);border:2px solid var(--line)}\n.duel-root .alt b{font-size:20px}\n.duel-root .kbd{opacity:.55;font-weight:500}\n.duel-root .ov{position:absolute;inset:0;background:rgba(6,7,14,.80);display:flex;align-items:flex-end;padding:0 14px calc(18px + env(safe-area-inset-bottom,0px))}\n.duel-root .card{width:100%;border-radius:22px;background:#15161B;border:1px solid #2E323A;padding:18px;display:flex;flex-direction:column;gap:12px}\n.duel-root .card h1{margin:0;font:800 42px/.95 var(--f-game)}\n.duel-root .tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}\n.duel-root .tile{border-radius:14px;padding:12px 8px;text-align:center;display:flex;flex-direction:column;gap:6px;align-items:center}\n.duel-root .tile b{font:800 20px/1 var(--f-game)}\n.duel-root .tile small{font-size:12px;line-height:1.25}\n.duel-root .lobby{gap:12px}\n.duel-root .lhead{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.duel-root .me-chip{text-align:right;line-height:1}\n.duel-root .me-chip b{display:block;font:800 22px/1 var(--f-game);color:var(--gold)}\n.duel-root .me-chip small{font:600 12px/1 var(--f-ui);color:var(--muted)}\n.duel-root .tabs{display:flex;background:#0e0f18;border:1px solid #2E323A;border-radius:14px;padding:4px;gap:4px}\n.duel-root .tab{flex:1;height:40px;border:0;border-radius:10px;background:transparent;color:var(--muted);font:800 18px/1 var(--f-game);letter-spacing:.8px}\n.duel-root .tab.on{background:#23262F;color:var(--text);box-shadow:inset 0 0 0 2px var(--gold)}\n.duel-root .online{display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:8px;font:600 13px/1 var(--f-ui);color:var(--muted)}\n.duel-root .online i{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}\n.duel-root [data-pane] .go{width:100%}\n.duel-root .join{display:flex;gap:6px;margin-top:8px}\n.duel-root .join input{flex:1;min-width:0;height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:#0b0c18;color:var(--text);font:700 18px/1 var(--f-game);letter-spacing:1px;padding:0 12px;text-transform:uppercase}\n.duel-root .join button{height:46px;padding:0 18px;border-radius:12px;border:2px solid var(--gold);background:transparent;color:var(--gold);font:800 18px/1 var(--f-game)}\n.duel-root .mm{align-items:stretch;text-align:center}\n.duel-root .mm h2{margin:0;font:800 32px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .mm .sub{margin:0;color:var(--muted);font-size:14px}\n.duel-root .sec{height:52px;margin-top:10px;border-radius:14px;background:#23262F;border:2px solid #2E323A;color:var(--text);font:800 19px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .sec:hover{border-color:#4a4f5a}\n.duel-root .sec:active{transform:scale(.97)}\n.duel-root .sec.wide{width:100%}\n.duel-root .sec.ghost{border-style:dashed!important;opacity:.75;font-size:15px!important}\n.duel-root .radar{position:relative;width:150px;height:150px;margin:6px auto 4px;border-radius:50%;background:radial-gradient(circle,rgba(242,193,78,.18),rgba(242,193,78,0) 70%);display:grid;place-items:center}\n.duel-root .radar i{position:absolute;inset:0;border-radius:50%;border:2px solid var(--gold);opacity:0;animation:ping 2.1s ease-out infinite}\n.duel-root .radar i:nth-child(2){animation-delay:.7s}\n.duel-root .radar i:nth-child(3){animation-delay:1.4s}\n.duel-root .radar b{font:800 34px/1 var(--f-game);font-variant-numeric:tabular-nums}\n@keyframes ping{0%{transform:scale(.35);opacity:.9}100%{transform:scale(1.05);opacity:0}}\n.duel-root .code{border-radius:16px;border:2px dashed var(--gold);padding:14px;background:rgba(242,193,78,.08);display:flex;flex-direction:column;gap:6px;align-items:center}\n.duel-root .code small{font:700 12px/1 var(--f-game);letter-spacing:1px;color:var(--muted)}\n.duel-root .code b{font:800 40px/1 var(--f-game);letter-spacing:2px;color:var(--gold)}\n.duel-root .code span{font:500 13px/1 var(--f-ui);color:var(--muted)}\n.duel-root .wait{display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;color:var(--muted)}\n.duel-root .spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:var(--gold);animation:rot 1s linear infinite}\n@keyframes rot{to{transform:rotate(360deg)}}\n.duel-root .vsrow{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px}\n.duel-root .vsx{font:800 30px/1 var(--f-game);color:var(--muted)}\n.duel-root .pc{border-radius:16px;padding:12px 8px;background:#1d1f27;border:2px solid #2E323A;display:flex;flex-direction:column;align-items:center;gap:5px}\n.duel-root .pc.me{border-color:var(--gold);background:rgba(242,193,78,.1)}\n.duel-root .pc:not(.me){border-color:var(--pink);background:rgba(240,48,127,.1)}\n.duel-root .pc .av{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;font:800 18px/1 var(--f-game);background:var(--gold);color:#121327}\n.duel-root .pc:not(.me) .av{background:var(--pink);color:#fff}\n.duel-root .pc b{font:800 19px/1 var(--f-game);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.duel-root .pc small{font:600 12px/1 var(--f-ui);color:var(--muted)}\n.duel-root .rdy{font:800 12px/1 var(--f-game);font-style:normal;letter-spacing:.8px;padding:4px 8px;border-radius:7px;background:#2a2d3a;color:var(--muted)}\n.duel-root .rdy.on{background:var(--green);color:#121327}\n.duel-root .opts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n.duel-root .budget{flex-wrap:nowrap}\n.duel-root .budget .opt{min-width:0}\n.duel-root .budget .bud{flex:1.25;min-width:0;display:flex;align-items:center;height:48px;border-radius:12px;background:#23262F;border:2px solid #2E323A;padding:0 8px;box-sizing:border-box;cursor:text}\n.duel-root .budget .bud.on{border-color:var(--gold);background:rgba(242,193,78,.16)}\n.duel-root .budget .bud i{font:800 17px/1 var(--f-game);color:var(--muted);font-style:normal}\n.duel-root .budget .bud input{width:100%;min-width:0;background:transparent;border:0;color:var(--text);font:800 17px/1 var(--f-game);outline:none;padding:0 0 0 3px}\n.duel-root .budget .bud input::placeholder{color:var(--muted)}\n.duel-root .opts span{font:700 12px/1 var(--f-game);letter-spacing:.6px;color:var(--muted);width:56px}\n.duel-root .opt{flex:1;height:40px;border-radius:12px;background:#23262F;border:2px solid #2E323A;font:800 17px/1 var(--f-game)}\n.duel-root .opt{height:48px!important;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}\n.duel-root .opt .ob{font:600 11px/1 var(--f-ui);color:var(--muted)}\n.duel-root .opt.on{border-color:var(--gold);background:rgba(242,193,78,.16)}\n.duel-root .go{height:58px;border-radius:16px;border:0;background:var(--gold);color:#121327;font:800 26px/1 var(--f-game);letter-spacing:1px}\n.duel-root .go:focus-visible,.duel-root .btn:focus-visible,.duel-root .opt:focus-visible{outline:3px solid #fff;outline-offset:2px}\n.duel-root .rk{display:inline-block;margin-left:2px;padding:4px 8px 3px;border-radius:999px;font:800 11px/1 var(--f-game);letter-spacing:.1em;text-transform:uppercase;font-style:normal;vertical-align:1px;white-space:nowrap}.duel-root .rk.on{background:rgba(242,193,78,.16);color:#F2C14E;box-shadow:inset 0 0 0 1px rgba(242,193,78,.45)}.duel-root .rk.un{background:rgba(255,255,255,.07);color:#C9CED6;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}.duel-root .choice.main .rk{background:rgba(18,19,39,.14);color:#121327;box-shadow:inset 0 0 0 1px rgba(18,19,39,.3)}.duel-root .fine{margin:0;font-size:11px;color:rgba(215,217,228,.55);text-align:center}\n.duel-root .res h1{text-align:center;font-size:60px}\n.duel-root .margin{text-align:center;margin:-8px 0 2px}\n.duel-root .margin small{display:block;font:700 13px/1 var(--f-game);letter-spacing:1.5px;color:var(--muted)}\n.duel-root .margin b{display:block;font:800 64px/1 var(--f-game);font-variant-numeric:tabular-nums}\n.duel-root .res.win .margin b{color:var(--gold);text-shadow:0 0 28px rgba(242,193,78,.45)}\n.duel-root .res.win{border-color:var(--gold)!important;box-shadow:0 0 0 3px rgba(242,193,78,.25),0 20px 60px rgba(0,0,0,.6)}\n.duel-root .res.win h1{animation:pop .5s cubic-bezier(.3,1.6,.5,1)}\n.duel-root .ov.winbg{background:rgba(6,7,14,.5)}\n@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}\n.duel-root .sc.won{border-color:var(--gold);background:rgba(242,193,78,.16)}\n.duel-root .sc .crown{float:right;font:800 11px/1 var(--f-game);letter-spacing:1px;background:var(--gold);color:#121327;padding:3px 6px;border-radius:6px}\n.duel-root .res .sub{margin:-6px 0 0;text-align:center;color:var(--muted);font-size:14px}\n.duel-root .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.duel-root .sc{border-radius:16px;padding:12px;background:#1d1f27;border:1px solid #2E323A}\n.duel-root .sc.me{background:rgba(242,193,78,.12);border-color:var(--gold)}\n.duel-root .sc small{display:block;font-size:12px;color:var(--muted)}\n.duel-root .sc b{display:block;font:800 40px/1 var(--f-game);margin:2px 0}\n.duel-root .moments{border-radius:16px;padding:10px 12px;background:#1d1f27;border:1px solid #2E323A;display:flex;flex-direction:column;gap:6px;max-height:150px;overflow:auto}\n.duel-root .moments div{display:flex;justify-content:space-between;gap:8px;font-size:13px}\n.duel-root .moments div b{font:800 16px/1 var(--f-game);white-space:nowrap}\n.duel-root .moments .t{font:700 13px/1 var(--f-game);color:var(--muted);margin-right:6px}\n.duel-root .stats{display:flex;gap:8px}\n.duel-root .stats div{flex:1;border-radius:14px;padding:8px 10px;background:#1d1f27;border:1px solid #2E323A}\n.duel-root .stats small{display:block;font-size:11px;color:var(--muted)}\n.duel-root .stats b{font:800 20px/1 var(--f-game)}\n.duel-root .rrow{display:flex;gap:8px}\n.duel-root .rrow .go{flex:2}\n.duel-root .res .save{width:100%;margin-top:8px;height:50px;font-size:19px;background:transparent;color:var(--gold);border:2px solid var(--gold);box-shadow:none}\n.duel-root .rrow .sec{flex:1;height:58px;border-radius:16px;background:#23262F;border:2px solid #2E323A;font:800 20px/1 var(--f-game)}\n.duel-root .toast{position:absolute;left:50%;top:calc(var(--ch) + 150px);transform:translateX(-50%);padding:9px 14px;border-radius:12px;background:rgba(18,19,39,.94);border:1px solid var(--line);font-size:13px;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none}\n.duel-root .toast.show{opacity:1}\n.duel-root .redv{position:absolute;inset:0;pointer-events:none;z-index:5;opacity:0;background:radial-gradient(ellipse at center,rgba(240,20,60,0) 42%,rgba(240,20,60,.38) 72%,rgba(240,20,60,.85) 100%);box-shadow:inset 0 0 0 5px rgba(255,60,90,.85),inset 0 0 60px rgba(240,20,60,.6)}\n.duel-root .count{position:absolute;inset:0;display:grid;place-items:center;font:800 120px/1 var(--f-game);text-shadow:0 6px 30px rgba(0,0,0,.6);pointer-events:none}\n@media (min-width:900px) and (min-height:600px){.duel-root .app{width:100%;height:100%;border-radius:0;box-shadow:none;--ch:clamp(96px,calc(100vh - 560px),230px)}\n.duel-root .app.big{--ch:clamp(150px,calc(100vh - 500px),360px)}\n.duel-root .sb{left:50%;right:auto;width:720px;transform:translateX(-50%)}\n.duel-root .chart{left:max(24px,calc(50% - 520px));right:max(24px,calc(50% - 520px))}\n.duel-root .feed{left:24px}\n.duel-root .mute{right:24px}\n.duel-root .bottom{left:50%;right:auto;width:560px;transform:translateX(-50%)}\n.duel-root .toast{top:calc(var(--ch) + 170px)}\n.duel-root .ov{align-items:center;justify-content:center}\n.duel-root .card{max-width:520px}}\n.duel-root .sb .r{text-align:right}\n.duel-root{position:fixed;inset:0;z-index:50;height:100%;overflow:hidden;color:var(--text);font-family:var(--f-ui);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}\n.duel-root .sec.signin{width:100%;margin-top:8px}.duel-root .lerr{margin:6px 0 0;text-align:center;color:var(--pinkl);font-size:13px;min-height:16px}\n.duel-root .practice{display:block;width:100%;margin-top:8px;background:transparent;border:0;color:var(--muted);font:600 13px/1 var(--f-ui);text-decoration:underline;text-underline-offset:3px}\n.duel-root .pre{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;gap:14px;padding:calc(14px + env(safe-area-inset-top,0px)) 16px calc(18px + env(safe-area-inset-bottom,0px));overflow-y:auto;overflow-x:hidden;background:#07080c;transition:opacity .35s ease}\n.duel-root .pre.out{opacity:0;pointer-events:none}\n.duel-root .pre>*:not(.pre-bg){position:relative;z-index:1}\n.duel-root .pre-top{width:100%;max-width:980px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}\n.duel-root .pre-back{justify-self:start;display:inline-flex;align-items:center;gap:4px;height:36px;padding:0 12px 0 8px;border-radius:12px;background:rgba(18,19,39,.7);border:1px solid var(--line);color:var(--text);text-decoration:none;font:800 15px/1 var(--f-game);letter-spacing:.6px}\n.duel-root .pre-back:focus-visible{outline:3px solid #fff;outline-offset:2px}\n.duel-root .pre-title{font:800 26px/1 var(--f-game);letter-spacing:1px;white-space:nowrap}\n.duel-root .pre-top .me-chip{justify-self:end}\n.duel-root .steps{list-style:none;margin:0;padding:0;display:flex;gap:6px;width:100%;max-width:560px}\n.duel-root .steps li{flex:1;text-align:center;font:700 11px/1 var(--f-game);letter-spacing:.8px;color:rgba(215,217,228,.5);padding-top:8px;border-top:3px solid rgba(255,255,255,.14);white-space:nowrap}\n.duel-root .steps li.done{color:var(--muted);border-top-color:rgba(242,193,78,.5)}\n.duel-root .steps li.on{color:var(--gold);border-top-color:var(--gold)}\n.duel-root .alab{font:700 11px/1.2 var(--f-game);letter-spacing:.8px;color:var(--muted)}\n.duel-root .panel{width:100%;max-width:560px;border-radius:22px;background:rgba(21,22,27,.92);border:1px solid #2E323A;padding:16px;margin-bottom:auto}\n.duel-root .pane{display:flex;flex-direction:column;gap:12px}\n.duel-root .pane.mm{text-align:center}\n.duel-root .pane .sec{margin-top:0}\n.duel-root .stime{font:800 18px/1 var(--f-game);color:var(--text);font-variant-numeric:tabular-nums}\n.duel-root .keys{display:flex;flex-wrap:wrap;justify-content:center;gap:6px}\n.duel-root .keys span{font:600 12px/1 var(--f-ui);color:var(--muted);padding:7px 9px;border-radius:9px;background:#1d1f27;border:1px solid #2E323A}\n.duel-root .keys kbd{font:800 13px/1 var(--f-game);color:var(--text);margin-right:5px}\n.duel-root .toast{z-index:30}\n@media (max-width:420px){.duel-root .arena{grid-template-columns:1fr 64px 1fr;gap:6px}.duel-root .slot{min-height:168px;padding:12px 6px}.duel-root .slot .av{width:60px;height:60px;font-size:19px}.duel-root .slot b{font-size:19px}.duel-root .amid .vsx{font-size:30px}.duel-root .acount{font-size:60px}.duel-root .pre-title{font-size:22px}.duel-root .steps li{font-size:10px;letter-spacing:.3px}}\n@media (max-height:700px){.duel-root .slot{min-height:150px}.duel-root .pre{gap:10px}}\n@media (min-width:900px) and (min-height:600px){\n.duel-root .pre{gap:22px;padding-top:24px}\n.duel-root .pre-title{font-size:34px}\n.duel-root .steps{max-width:640px}\n.duel-root .steps li{font-size:13px}\n.duel-root .panel{max-width:560px;padding:20px}}\n/* pre-match lobby (maker 2026-11-16): the duel art is the hero, shown whole. Gold ship = you, pink ship = your rival.\n   The rival only gets a tag once there is one (searching, invite, match found); at set-up the pink ship stands alone. */\n.duel-root .pre-body{width:100%;max-width:980px;display:flex;flex-direction:column;align-items:center;gap:12px;margin:auto 0}\n.duel-root .pre-side{width:100%;max-width:560px;display:flex;flex-direction:column;align-items:center;gap:12px}\n.duel-root .arena{position:relative;width:100%;max-width:560px;aspect-ratio:1.4;border-radius:22px;overflow:hidden;background:#07080c;border:1px solid #2E323A;flex:none}\n.duel-root .art{position:absolute;left:0;right:0;top:-17%;aspect-ratio:2/3;background-size:100% 100%;background-repeat:no-repeat}\n.duel-root .art::after{content:\"\";position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,8,12,0) 46%,rgba(7,8,12,.5) 58%,rgba(7,8,12,.15) 70%,rgba(7,8,12,0) 100%);pointer-events:none}\n.duel-root .arena::after{content:\"\";position:absolute;z-index:2;left:0;right:0;bottom:0;height:40%;background:linear-gradient(180deg,rgba(7,8,12,0),rgba(7,8,12,.92));pointer-events:none}\n.duel-root .art>*,.duel-root .arena>.tag,.duel-root .arena>.acnt{position:absolute;z-index:3}\n.duel-root .art .vsx{left:51.5%;top:21%;transform:translate(-50%,-50%) skewX(-8deg);font:800 34px/1 var(--f-game);letter-spacing:1px;color:rgba(242,243,247,.82);text-shadow:0 2px 18px rgba(0,0,0,.6)}\n.duel-root .tag{display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:12px;background:rgba(11,10,22,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1.5px solid var(--gold);white-space:nowrap;transform:translate(-50%,0)}\n.duel-root .tag b{font:800 20px/1 var(--f-game);letter-spacing:.4px}\n.duel-root .tag small{font:600 12px/1.2 var(--f-ui);color:var(--muted)}\n.duel-root .tag.me{left:30.5%;bottom:12px}\n.duel-root .tag.me b{color:var(--gold)}\n.duel-root .tag.rival{left:73.5%;bottom:12px;border-color:var(--pink);max-width:52%}\n.duel-root .tag .tx{display:flex;flex-direction:column;gap:2px;min-width:0}\n.duel-root .tag.rival b{font-size:18px;overflow:hidden;text-overflow:ellipsis}\n.duel-root .tag .av{width:26px;height:26px;border-radius:50%;display:none;place-items:center;flex:none;font:800 12px/1 var(--f-game);background:var(--pink);color:#fff}\n.duel-root .tag .rdy{padding:3px 6px;font-size:11px}\n@media (max-width:899px),(max-height:599px){.duel-root .tag{transform:none;max-width:calc(50% - 16px)}.duel-root .tag.me{left:10px}.duel-root .tag.rival{left:auto;right:10px}.duel-root .tag .rdy{position:absolute;top:-10px;right:8px;padding:3px 5px;font-size:10px}.duel-root .tag b{overflow:hidden;text-overflow:ellipsis}}\n.duel-root .arena[data-stage=intro] .tag.rival{display:none}\n.duel-root .arena[data-stage=vs] .tag .av,.duel-root .arena[data-stage=launch] .tag .av{display:grid;animation:pop .45s cubic-bezier(.3,1.6,.5,1)}\n.duel-root .arena[data-stage=search] .tag.rival,.duel-root .arena[data-stage=invite] .tag.rival{border-style:dashed;border-color:rgba(255,143,189,.7)}\n.duel-root .art .radar{left:73.5%;top:31%;width:46%;height:auto;aspect-ratio:1;margin:0;transform:translate(-50%,-50%);background:none;display:none}\n.duel-root .art .radar i{border-color:var(--pinkl)}\n.duel-root .arena[data-stage=search] .radar,.duel-root .arena[data-stage=invite] .radar{display:block}\n.duel-root .acnt{left:50%;top:58%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}\n.duel-root .acount{font:800 84px/1 var(--f-game);color:var(--gold);text-shadow:0 0 30px rgba(242,193,78,.55);font-variant-numeric:tabular-nums;animation:pop .4s cubic-bezier(.3,1.6,.5,1)}\n.duel-root .alab{font:700 12px/1.2 var(--f-game);letter-spacing:.8px;color:var(--text);text-shadow:0 1px 8px rgba(0,0,0,.8)}\n.duel-root .alab em{display:block;font-style:normal;color:var(--muted);margin-top:2px}\n.duel-root .arena .cap{position:absolute;z-index:2;left:0;right:0;bottom:14px;margin:0;display:none;text-align:center;font:700 13px/1.2 var(--f-game);letter-spacing:.8px;color:var(--muted);text-transform:uppercase}\n.duel-root .arena[data-stage=launch] .cap{display:none}\n.duel-root .pre-side .panel{margin-bottom:0}\n@media (max-width:420px){.duel-root .pre-title{font-size:22px}.duel-root .steps li{font-size:10px;letter-spacing:.3px}.duel-root .tag{padding:6px 8px;gap:6px}.duel-root .tag b{font-size:17px}.duel-root .tag.rival b{font-size:15px}.duel-root .tag small{font-size:11px}.duel-root .art .vsx{font-size:28px}.duel-root .acount{font-size:64px}}\n@media (max-height:700px){.duel-root .arena{aspect-ratio:1.6}.duel-root .art{top:-22%}.duel-root .pre{gap:10px}}\n@media (min-width:900px) and (min-height:600px){\n.duel-root .pre{gap:16px;padding-top:24px}\n.duel-root .pre-bg{background-size:cover;background-position:50% 30%;opacity:.4;filter:blur(26px) saturate(1.1);transform:scale(1.08)}\n.duel-root .pre-body{flex-direction:row;align-items:center;justify-content:center;gap:36px;max-width:1140px}\n.duel-root .arena{width:auto;max-width:none;height:min(calc(100vh - 140px),820px);aspect-ratio:2/3;border-radius:26px;box-shadow:0 30px 80px rgba(0,0,0,.55)}\n.duel-root .art{top:0;bottom:0;height:100%}\n.duel-root .art::after{display:none}\n.duel-root .arena::after{height:22%}\n.duel-root .tag.me,.duel-root .tag.rival{top:60%;bottom:auto}\n.duel-root .arena .cap{display:block}\n.duel-root .art .radar{top:31%}\n.duel-root .tag b{font-size:22px}\n.duel-root .art .vsx{font-size:44px}\n.duel-root .acount{font-size:120px}\n.duel-root .acnt{top:70%}\n.duel-root .pre-side{width:560px;flex:none;gap:18px}\n.duel-root .pre-side .steps{max-width:none}\n.duel-root .panel{max-width:560px;padding:20px}}\n@media (min-width:900px) and (max-height:760px){.duel-root .tag b{font-size:18px}.duel-root .tag{padding:6px 9px}}\n/* Play Online / Play a Bot (maker 2026-11-16, like chess sites: two clear choices instead of a text link) */\n.duel-root .choices{display:flex;flex-direction:column;gap:10px}\n.duel-root .choice{display:flex;align-items:center;gap:14px;width:100%;min-height:72px;padding:12px 16px;border-radius:16px;border:1.5px solid #2E323A;background:#1b1d26;color:var(--text);text-align:left;transition:transform .12s ease,border-color .2s,background .2s}\n.duel-root .choice:hover{border-color:rgba(255,255,255,.3)}\n.duel-root .choice:active{transform:scale(.985)}\n.duel-root .choice:focus-visible{outline:3px solid #fff;outline-offset:2px}\n.duel-root .choice .ci{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#262936;color:var(--muted);font-style:normal}\n.duel-root .choice .ct{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}\n.duel-root .choice b{font:800 24px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .choice small{font:600 13px/1.25 var(--f-ui);color:var(--muted)}\n.duel-root .choice .cgo{flex:none;opacity:.6}\n.duel-root .choice.main{background:var(--gold);border-color:var(--gold);color:#121327}\n.duel-root .choice.main .ci{background:rgba(18,19,39,.12);color:#121327}\n.duel-root .choice.main small{color:rgba(18,19,39,.72)}\n.duel-root .choice.main:hover{background:#f5cb63}\n@media (max-width:420px){.duel-root .choice{min-height:64px;padding:10px 12px;gap:12px}.duel-root .choice .ci{width:38px;height:38px}.duel-root .choice b{font-size:21px}.duel-root .choice small{font-size:12px}}\n.duel-root .size.pct>span{display:none}.duel-root .size.pct{padding-left:5px}.duel-root .side .kh,.duel-root .pill .kh{display:none!important}";
const HTML="<div class=\"stage\"><div class=\"app\" id=\"app\">\n<canvas id=\"sky\" aria-label=\"Your rocket and your rival's rocket racing. The higher rocket has made more profit.\"></canvas>\n\n<div class=\"sb\" aria-live=\"off\">\n  <div><span class=\"who\">YOU \u00b7 <span id=\"meN\">0</span></span><b id=\"meP\">$0.00</b></div>\n  <div class=\"mid\" id=\"mid\"><b id=\"clock\">1:00</b><div class=\"lead\"><i id=\"leadI\"></i></div><small id=\"leadT\">EVEN</small></div>\n  <div class=\"r\"><span class=\"who r\" id=\"botLab\">@SOLWHALE \u00b7 <span id=\"botN\">0</span></span><b id=\"botP\">$0.00</b></div>\n</div>\n\n<button class=\"chart\" id=\"chart\" type=\"button\" aria-label=\"BTC tick chart, last 60 seconds. Tap to make it bigger.\"><canvas id=\"cc\"></canvas><span class=\"lab\"><i class=\"coin\" aria-hidden=\"true\">\u20bf</i><b>BTC</b><span id=\"chLab\">BITCOIN \u00b7 LAST 60S</span></span></button>\n<div class=\"feed\" id=\"feed\"></div>\n<button class=\"mute chatb\" id=\"chatB\" type=\"button\" aria-label=\"Chat\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#F2F3F7\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z\"/></svg><span class=\"dot\" id=\"chatDot\" hidden></span></button>\n<div class=\"chat\" id=\"chat\" hidden>\n  <div class=\"quick\" id=\"quick\"></div>\n  <form class=\"say\" id=\"sayF\" autocomplete=\"off\"><input id=\"sayI\" maxlength=\"60\" placeholder=\"Say something\" aria-label=\"Chat message\" enterkeyhint=\"send\"><button type=\"submit\">SEND</button></form>\n  <div class=\"ctools\"><button type=\"button\" id=\"cMute\" aria-pressed=\"false\">MUTE CHAT</button><button type=\"button\" id=\"cRep\">REPORT</button></div>\n</div>\n<button class=\"mute\" id=\"mute\" type=\"button\" aria-label=\"Mute sound\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#F2F3F7\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 9v6h4l5 4V5L8 9z\"/><path id=\"mWave\" d=\"M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11\"/><path id=\"mX\" d=\"M16 9l5 6M21 9l-5 6\" hidden/></svg></button>\n\n<div class=\"bottom\">\n  <div class=\"size pct\" role=\"group\" aria-label=\"Trade size\">\n    <span>TRADE SIZE</span>\n    <button type=\"button\" data-i=\"0\">10%</button><button type=\"button\" data-i=\"1\" class=\"on\">25%</button><button type=\"button\" data-i=\"2\">50%</button><button type=\"button\" data-i=\"3\">ALL</button>\n  </div>\n  <div class=\"ctl\">\n    <button class=\"side boost\" id=\"bBoost\" type=\"button\" aria-label=\"Boost: price goes up\"><b>\u25b2</b><span id=\"bBoostS\">BOOST</span><small id=\"bBoostA\">$5</small><small class=\"kh\">SPACE</small></button>\n    <button class=\"pill\" id=\"bOut\" type=\"button\" disabled aria-live=\"polite\">\n      <small id=\"posLab\">DUEL FUEL</small>\n      <span class=\"pv\"><b id=\"posV\">$20.00</b><em id=\"pnlP\" hidden>+0.0%</em></span>\n      <small id=\"bOutS\"></small><small class=\"kh\">ENTER</small>\n    </button>\n    <button class=\"side dump\" id=\"bDump\" type=\"button\" aria-label=\"Dump: price goes down\"><b>\u25bc</b><span id=\"bDumpS\">DUMP</span><small id=\"bDumpA\">$5</small><small class=\"kh\">SHIFT</small></button>\n  </div>\n</div>\n\n<div class=\"redv\" id=\"redv\" aria-hidden=\"true\"></div>\n<div class=\"toast\" id=\"toast\" role=\"status\"></div>\n<div class=\"count\" id=\"count\" hidden></div>\n\n<div class=\"pre\" id=\"pre\">\n  <div class=\"pre-bg\" id=\"preBg\" aria-hidden=\"true\"></div>\n  <header class=\"pre-top\">\n    <a class=\"pre-back\" href=\"/\" aria-label=\"Back to the lobby\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M15 5l-7 7 7 7\"/></svg>BACK</a>\n    <div class=\"pre-title\">TRADING DUEL</div>\n    <div class=\"me-chip\"><b id=\"lRat\">1,200</b><small id=\"lRec\">0-0</small></div>\n  </header>\n  <div class=\"pre-body\">\n  <div class=\"arena\" id=\"arena\" data-stage=\"intro\">\n    <div class=\"art\" id=\"preArt\" role=\"img\" aria-label=\"Your gold rocket and your rival's pink rocket, side by side\">\n      <span class=\"vsx\" id=\"aVs\">VS</span>\n      <div class=\"radar\" id=\"aRadar\" aria-hidden=\"true\"><i></i><i></i><i></i></div>\n    </div>\n    <video class=\"avid\" id=\"aVid\" muted loop playsinline preload=\"none\" aria-hidden=\"true\"></video>\n    <div class=\"tag me\"><span class=\"tx\"><b>YOU</b><small id=\"vMe\">1,200 \u00b7 0-0</small></span><em class=\"rdy\" id=\"vMeR\">NOT READY</em></div>\n    <div class=\"tag rival\" id=\"slotR\"><span class=\"av\" id=\"vAv\">?</span><span class=\"tx\"><b id=\"vName\">your rival</b><small id=\"vThem\"></small></span><em class=\"rdy\" id=\"vThemR\">WAITING</em></div>\n    <div class=\"acnt\"><small class=\"alab\" id=\"aLab\"></small><b class=\"acount\" id=\"preCount\" hidden>3</b></div>\n  </div>\n  <div class=\"pre-side\">\n  <ol class=\"steps\" id=\"steps\" aria-label=\"Match steps\"><li data-s=\"1\">SET UP</li><li data-s=\"2\">FIND RIVAL</li><li data-s=\"3\">READY CHECK</li><li data-s=\"4\">LAUNCH</li></ol>\n  <div class=\"panel\">\n  <div class=\"pane\" id=\"intro\">\n    <div class=\"tabs\" role=\"tablist\"><button class=\"tab on\" type=\"button\" data-tab=\"ranked\" role=\"tab\" id=\"tabRanked\">RANKED</button><button class=\"tab\" type=\"button\" data-tab=\"friend\" role=\"tab\">FRIEND</button></div>\n    <div class=\"opts\" role=\"group\" aria-label=\"Tier\" data-pane=\"ranked\"><span>TIER</span>\n      <button class=\"opt\" type=\"button\" data-bot=\"rookie\">NORMIE<small class=\"ob\">$20 fuel</small></button><button class=\"opt on\" type=\"button\" data-bot=\"pro\">DEGEN<small class=\"ob\">$50 fuel</small></button><button class=\"opt\" type=\"button\" data-bot=\"shark\">WHALE<small class=\"ob\">$150 fuel</small></button>\n    </div>\n    <div class=\"opts budget\" role=\"group\" aria-label=\"Budget\" data-pane=\"friend\" hidden><span>BUDGET</span><button class=\"opt\" type=\"button\" data-fuel=\"5\">$5</button><button class=\"opt\" type=\"button\" data-fuel=\"100\">$100</button><button class=\"opt\" type=\"button\" data-fuel=\"1000\">$1K</button><label class=\"bud\"><i>$</i><input id=\"budI\" inputmode=\"numeric\" maxlength=\"5\" placeholder=\"ANY\" aria-label=\"Custom budget in dollars, 5 to 10,000\"></label>\n    </div>\n    <p class=\"lerr\" id=\"lErr\" role=\"status\"></p>\n    <div data-pane=\"ranked\">\n      <div class=\"choices\"><button class=\"choice main\" type=\"button\" id=\"go\"><i class=\"ci\"><svg viewBox=\"0 0 24 24\" width=\"26\" height=\"26\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13 2 4 14h7l-1 8 9-12h-7z\"/></svg></i><span class=\"ct\"><b>PLAY ONLINE</b><small id=\"goSub\">Ranked</small></span><svg class=\"cgo\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m9 6 6 6-6 6\"/></svg></button><button class=\"choice\" type=\"button\" id=\"goC\" hidden><i class=\"ci\"><svg viewBox=\"0 0 24 24\" width=\"26\" height=\"26\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13 2 4 14h7l-1 8 9-12h-7z\"/></svg></i><span class=\"ct\"><b>PLAY UNRANKED</b><small><em class=\"rk un\">UNRANKED</em></small></span><svg class=\"cgo\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m9 6 6 6-6 6\"/></svg></button><button class=\"choice \" type=\"button\" id=\"lPractice\"><i class=\"ci\"><svg viewBox=\"0 0 24 24\" width=\"26\" height=\"26\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"4\" y=\"7\" width=\"16\" height=\"12\" rx=\"3\"/><path d=\"M12 3v4M9 12h.01M15 12h.01M9 16h6M2 12v3M22 12v3\"/></svg></i><span class=\"ct\"><b>PLAY A BOT</b><small id=\"botSub\">Play money <em class=\"rk un\">UNRANKED</em></small></span><svg class=\"cgo\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m9 6 6 6-6 6\"/></svg></button></div>\n    </div>\n    <div data-pane=\"friend\" hidden>\n      <button class=\"go\" type=\"button\" id=\"mkLink\">CREATE DUEL LINK</button>\n      <form class=\"join\" id=\"joinF\" autocomplete=\"off\"><input id=\"joinI\" maxlength=\"9\" placeholder=\"Have a code? DUEL-XXXX\" aria-label=\"Duel code\"><button type=\"submit\">JOIN</button></form>\n      <p class=\"fine\" style=\"margin-top:10px\" id=\"budF\"><em class=\"rk un\">UNRANKED</em></p>\n    </div>\n  </div>\n\n  <div class=\"pane mm\" id=\"search\" hidden>\n    <h2 id=\"sH\">FINDING A RIVAL</h2>\n    <p class=\"sub\"><b class=\"stime\" id=\"sT\">0:00</b> \u00b7 <span id=\"sSub\">PRO \u00b7 1 MIN \u00b7 near 1,200</span></p>\n    <button class=\"go\" type=\"button\" id=\"sBot\" hidden>PLAY A BOT NOW</button>\n    <button class=\"sec wide\" type=\"button\" id=\"sCancel\">CANCEL</button>\n  </div>\n\n  <div class=\"pane mm\" id=\"invite\" hidden>\n    <h2>CHALLENGE A FRIEND</h2>\n    <p class=\"sub\" id=\"iSub\">PRO \u00b7 $50 fuel \u00b7 1 MIN</p>\n    <div class=\"code\"><small>DUEL CODE</small><b id=\"iCode\">DUEL-\u00b7\u00b7\u00b7\u00b7</b><span id=\"iLink\"></span></div>\n    <div class=\"rrow\"><button class=\"sec\" type=\"button\" id=\"iCopy\">COPY LINK</button><button class=\"sec\" type=\"button\" id=\"iX\">POST ON X</button></div>\n    <div class=\"wait\"><span class=\"spin\"></span><span id=\"iWait\">Waiting for your friend to open the link\u2026</span></div>\n    <button class=\"sec wide\" type=\"button\" id=\"iCancel\">CANCEL</button>\n  </div>\n\n  <div class=\"pane mm\" id=\"vs\" hidden>\n    <h2 id=\"vTag\">MATCH FOUND</h2>\n    <p class=\"sub\" id=\"vSub\">PRO \u00b7 $50 fuel each \u00b7 1 MIN</p>\n    <button class=\"go\" type=\"button\" id=\"vReady\">READY</button>\n    <p class=\"fine\" id=\"vAuto\">Auto-ready in <span id=\"vT\">10</span>s</p>\n    <button class=\"sec wide\" type=\"button\" id=\"vLeave\">LEAVE</button>\n  </div>\n\n  <div class=\"pane mm\" id=\"launch\" hidden>\n    <h2 id=\"lH\">BOTH READY</h2>\n    <p class=\"sub\" id=\"lSub\"></p>\n    <div class=\"keys\" id=\"lKeys\"></div>\n    <button class=\"sec wide\" type=\"button\" id=\"lCancel\" hidden>CANCEL</button>\n  </div>\n  </div>\n  </div>\n  </div>\n</div>\n\n<video class=\"rvid\" id=\"rVid\" muted playsinline preload=\"auto\" aria-hidden=\"true\" hidden></video>\n<video class=\"nvid\" id=\"nVid\" muted playsinline preload=\"auto\" aria-hidden=\"true\" hidden></video>\n\n<div class=\"ov\" id=\"result\" hidden>\n  <div class=\"card res\">\n    <h1 id=\"rH\">YOU WIN</h1>\n    <div class=\"margin\" id=\"rMarg\"><small id=\"rMargL\">WON BY</small><b id=\"rMargV\">$0.00</b></div>\n    <p class=\"sub\" id=\"rSub\"></p>\n    <div class=\"fcrate\" id=\"rCrate\" hidden aria-live=\"polite\"><div class=\"fc-box\"><img id=\"rCrateImg\" alt=\"\"><img id=\"rCrateItem\" alt=\"\" hidden></div><div class=\"fc-t\"><small id=\"rCrateK\">FIRST WIN CRATE</small><b id=\"rCrateN\"></b><span id=\"rCrateS\"></span></div></div>\n    <div class=\"two\">\n      <div class=\"sc me\"><small>you</small><b id=\"rMe\"></b><small id=\"rMeS\"></small></div>\n      <div class=\"sc\"><small id=\"rBotN\">@solwhale</small><b id=\"rBot\"></b><small id=\"rBotS\"></small></div>\n    </div>\n    <div class=\"moments\" id=\"rMom\"></div>\n    <div class=\"stats\"><div><small>Record</small><b id=\"rRec\">0-0</b></div><div><small>Rating</small><b id=\"rRat\">1,200</b></div><div><small>Win streak</small><b id=\"rStr\">0</b></div></div>\n    <div class=\"sline\" id=\"rSeason\" hidden></div>\n    <div class=\"rrow\"><button class=\"sec\" type=\"button\" id=\"rBack\">LOBBY</button><button class=\"sec\" type=\"button\" id=\"rShare\">SHARE</button><button class=\"go\" type=\"button\" id=\"rAgain\">REMATCH</button></div>\n    <button class=\"go save\" type=\"button\" id=\"rSave\" hidden>SAVE YOUR WIN</button>\n    <a class=\"xlink\" id=\"rClimb\" hidden></a>\n  </div>\n</div>\n</div></div>\n\n";
/*FLYSKY{*/
// Flying feel (maker 2026-11-16: "this mode should feel like flying still, with the clouds"): soft clouds in three depths
// that stream past as you climb and slide with the camera when you fly up or down, thick low in the sky, thin in space.
function flySky(rnd,reduce){
  const SPR=[]; function sprite(seed){ const c=document.createElement("canvas"); c.width=320; c.height=150; const x=c.getContext("2d");
    let r=seed*7919+13; const q=()=>((r=(r*16807)%2147483647)/2147483647);
    for(let i=0;i<16;i++){ const cx=40+q()*240, cy=60+q()*40-(Math.abs(cx-160)<80?14:0), rr=24+q()*42;
      const g=x.createRadialGradient(cx,cy,0,cx,cy,rr); g.addColorStop(0,"rgba(236,238,250,.55)"); g.addColorStop(.55,"rgba(226,230,246,.28)"); g.addColorStop(1,"rgba(220,224,244,0)");
      x.fillStyle=g; x.beginPath(); x.arc(cx,cy,rr,0,7); x.fill(); }
    return c; }
  for(let i=0;i<5;i++) SPR.push(sprite(i+1));
  const L=[{z:.35,n:7,a:.5,s:.7},{z:.65,n:5,a:.66,s:1.05},{z:1.35,n:3,a:.32,s:1.8}];   // far, near, in front of the rockets
  let C=null, W=0, H=0;
  function seed(w,h){ W=w; H=h; C=L.map(l=>Array.from({length:l.n},()=>({x:rnd(-.1,1.1)*w,y:rnd(-.2,1.2)*h,k:Math.floor(rnd(0,SPR.length))%SPR.length,s:l.s*rnd(.8,1.25)*(w<600?.75:1),f:rnd(0,1)<.5}))); }
  // dy: px the world moved down this frame (camera climbing = +), dens 0..1, layer 0/1 = behind, 2 = in front
  function step(ctx,w,h,dt,dy,dens,layers,speed){ if(!C||w!==W||h!==H) seed(w,h);
    for(const li of layers){ const l=L[li]; for(const c of C[li]){ const sw=320*c.s, sh=150*c.s;
      c.y+=((reduce?0:speed)*dt+dy)*l.z; c.x+=(reduce?0:4)*l.z*dt;
      if(c.y>h+sh*.6){ c.y-=h+sh*1.4; c.x=rnd(-.1,1.1)*w; } else if(c.y<-sh*.8){ c.y+=h+sh*1.4; c.x=rnd(-.1,1.1)*w; }
      if(c.x>w+sw*.5) c.x=-sw*.5;
      const a=l.a*dens; if(a<.02) continue; ctx.globalAlpha=a;
      if(c.f){ ctx.save(); ctx.translate(c.x,c.y); ctx.scale(-1,1); ctx.drawImage(SPR[c.k],-sw/2,-sh/2,sw,sh); ctx.restore(); } else ctx.drawImage(SPR[c.k],c.x-sw/2,c.y-sh/2,sw,sh); } }
    ctx.globalAlpha=1; }
  return {step};
}
/*}FLYSKY*/
function mount(root,host){
  // ranked = real money only (maker 2026-11-17): until real-money duels are live the online queue is unranked, no rating shown
  const RL=!!host.rankedLive;
  let dead=false; const offs=[];
  const track=k=>{ try{ host.track&&host.track(k); }catch(e){} };   // funnel counter (lib/funnel TURBO_STEPS), once per browser
  const on=(t,ev,f,o)=>{ t.addEventListener(ev,f,o); offs.push(()=>t.removeEventListener(ev,f,o)); };
  // result card fits one screen (maker 2026-11-17: "cropped weird"): tighter blocks, the card scrolls inside the overlay
  // instead of centring off the top, and short screens drop the promo and keep 2 log rows. Kept apart from CSS so the big line stays untouched.
  const GEAR_CSS=".duel-root .pre-r{justify-self:end;display:flex;align-items:center;gap:10px;min-width:0}"
    +".duel-root .pre-gear{flex:none;display:grid;place-items:center;width:36px;height:36px;padding:0;border-radius:12px;background:rgba(18,19,39,.7);border:1px solid var(--line);color:var(--text);cursor:pointer}"
    +".duel-root .pre-gear:hover{border-color:rgba(242,193,78,.55);color:var(--gold)}.duel-root .pre-gear:focus-visible{outline:3px solid #fff;outline-offset:2px}";
  // the in-match X takes the top of the right-hand column; sound, chat and LAND each move down one slot
  const QUIT_CSS=".duel-root #quitB{top:calc(var(--ch) + 86px + env(safe-area-inset-top,0px))}"
    +".duel-root #mute{top:calc(var(--ch) + 138px + env(safe-area-inset-top,0px))}"
    +".duel-root #chatB,.duel-root #landB{top:calc(var(--ch) + 190px + env(safe-area-inset-top,0px))!important}"
    +".duel-root.climb #landB{top:calc(var(--ch) + 190px + env(safe-area-inset-top,0px))!important}"
    +".duel-root .quitov{z-index:70}.duel-root .qcard{max-width:420px}.duel-root .qcard h2{margin:0;font:800 32px/1 var(--f-game);letter-spacing:.5px}"
    +".duel-root .qwarn{margin:0;display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:rgba(240,48,127,.10);border:1px solid rgba(240,48,127,.4);color:var(--pinkl);font:700 15px/1.2 var(--f-ui,system-ui,sans-serif)}"
    +".duel-root .qcard .rrow>*{flex:1}";
  const RES_CSS=".duel-root #result{overflow-y:auto;overscroll-behavior:contain;padding-top:calc(12px + env(safe-area-inset-top,0px))}"
    +".duel-root #result .res{margin:auto 0 0;gap:10px;padding:16px}"
    +"@media (min-width:900px) and (min-height:600px){.duel-root #result{padding:16px}.duel-root #result .res{margin:auto}}"
    +".duel-root .res h1{font-size:48px;line-height:.9}.duel-root .res .margin{margin:-4px 0 0}.duel-root .res .margin b{font-size:52px}"
    +".duel-root .res .margin .otc{display:inline-block;margin-left:6px;padding:2px 5px;border-radius:5px;background:var(--pinkl);color:#121327;font-size:10px;letter-spacing:.8px;vertical-align:1px}"
    +".duel-root .res .sub{display:none}"
    +".duel-root .res .fcrate{margin:0;padding:6px 12px;gap:12px}.duel-root .res .fc-box{width:56px;height:56px}.duel-root .res .fc-t b{font-size:20px}"
    +".duel-root .res .sc{padding:9px 12px}.duel-root .res .sc b{font-size:30px}"
    +".duel-root .res .moments{max-height:none;overflow:visible;gap:5px;padding:8px 12px}"
    +".duel-root .res .stats div{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:7px 10px}.duel-root .res .stats small{font-size:12px}.duel-root .res .stats b{font-size:18px}"
    +".duel-root .res .sline{margin-top:0;padding:8px 12px}"
    +".duel-root .res .rrow .sec,.duel-root .res .rrow .go{height:52px}.duel-root .res .rrow .go{font-size:24px}"
    +".duel-root .res .save{margin-top:0;height:44px;font-size:17px}.duel-root .res .xlink{margin-top:0;padding:9px 12px}"
    // out-of-fuel callout (fuelOut): sits on the trade bar, tail points at the CASH OUT pill
    +".duel-root .fuelout{position:absolute;left:50%;bottom:calc(100% + 12px);z-index:31;display:flex;align-items:stretch;border-radius:12px;background:#15161B;border:2px solid var(--pinkl);box-shadow:0 0 0 4px rgba(255,143,189,.16),0 12px 30px rgba(0,0,0,.55);font:800 19px/1 var(--f-game);letter-spacing:.8px;white-space:nowrap;opacity:0;transform:translate(-50%,8px) scale(.96);transition:opacity .15s,transform .2s;pointer-events:none}"
    +".duel-root .fuelout.show{opacity:1;transform:translate(-50%,0);animation:fuelShake .36s ease-out}"
    +".duel-root .fuelout b{display:flex;align-items:center;gap:8px;padding:9px 12px;color:var(--pinkl)}"
    +".duel-root .fuelout i{position:relative;width:24px;height:12px;border:2px solid var(--pinkl);border-radius:3px}"
    +".duel-root .fuelout i::before{content:'';position:absolute;left:2px;top:2px;bottom:2px;width:3px;border-radius:1px;background:#FF4D6D;animation:fuelBlink .5s steps(2) infinite}"
    +".duel-root .fuelout i::after{content:'';position:absolute;right:-5px;top:2px;width:3px;height:4px;border-radius:0 1px 1px 0;background:var(--pinkl)}"
    +".duel-root .fuelout span{display:flex;align-items:center;padding:9px 12px;background:var(--gold);color:#121327;border-radius:0 9px 9px 0}"
    +".duel-root .fuelout::after{content:'';position:absolute;left:50%;top:100%;margin-left:-8px;border:8px solid transparent;border-top-color:var(--pinkl)}"
    +".duel-root #bOut.nudge{animation:fuelNudge .55s ease-in-out 3}"
    +"@keyframes fuelShake{0%{transform:translate(-50%,8px)}35%{transform:translate(calc(-50% - 6px),0)}55%{transform:translate(calc(-50% + 5px),0)}75%{transform:translate(calc(-50% - 3px),0)}100%{transform:translate(-50%,0)}}"
    +"@keyframes fuelBlink{50%{opacity:0}}"
    +"@keyframes fuelNudge{50%{box-shadow:0 0 0 4px var(--gold),0 0 26px rgba(242,193,78,.6);transform:scale(1.04)}}"
    +"@media (prefers-reduced-motion:reduce){.duel-root .fuelout,.duel-root .fuelout i::before,.duel-root #bOut.nudge{animation:none}}"
    +"@media (max-height:720px){.duel-root .res .xlink{display:none}.duel-root .res .moments div:nth-child(n+3){display:none}.duel-root .res h1{font-size:40px}.duel-root .res .margin b{font-size:44px}.duel-root .res .sc b{font-size:26px}}";
  let st=document.getElementById("duel-css"); if(!st){ st=document.createElement("style"); st.id="duel-css"; st.textContent=CSS+RES_CSS; document.head.appendChild(st); }
  root.classList.add("duel-root"); root.innerHTML=HTML;
  if(!RL){ const t=root.querySelector("#tabRanked"); if(t) t.textContent="ONLINE"; }
  // unranked online queue (maker 2026-11-18): only once ranked is live; before that the online queue is already unranked
  if(RL&&!host.guest){ const c=root.querySelector("#goC"); if(c) c.hidden=false; }
  const cssv=n=>getComputedStyle(document.body).getPropertyValue(n).trim();
  const GF=cssv("--font-barlow-condensed")||"'Barlow Condensed'", GU=cssv("--font-geist")||"Geist";

  const A=host.assets;
  const $=id=>document.getElementById(id);
  const imgs={}; for(const k in A){const i=new Image(); i.src=A[k]; imgs[k]=i;}
  // bot rockets: 8 hull shapes x 10 rival skins (PR 399/402 art, web/public/turbo/hulls). [aspect w/h, nozzles [x, y, size] as 0..1 of the image]
  const HULLS={"bullet":[0.454,[[0.498,0.988,1.0],[0.103,0.982,0.7],[0.892,0.982,0.7]]],"needle":[0.400,[[0.480,0.989,1.0]]],"pulp":[0.557,[[0.472,0.99,1.0]]],"twin-booster":[0.436,[[0.498,0.984,0.8],[0.193,0.99,1.0],[0.798,0.99,1.0]]],"shuttle":[0.575,[[0.5,0.984,1.0],[0.427,0.965,0.7],[0.573,0.965,0.7]]],"hauler":[0.432,[[0.498,0.99,1.0],[0.27,0.989,0.85],[0.734,0.989,0.85]]],"ring-tail":[0.432,[[0.502,0.99,1.0]]],"wedge":[0.732,[[0.501,0.959,1.0]]]}, HSKINS=["chrome-pink-stripe","matte-black","pearl-mint","titanium-ice","candy-pink","gunmetal-pink","oilslick","carbon","scorched","navy-chevron"], HULL_BASE=A.hullBase||"/turbo/hulls/", hullImgs={};
  function hullFor(used){ const ks=Object.keys(HULLS); let h,s,n=0; do{ h=ks[Math.floor(Math.random()*ks.length)]; s=HSKINS[Math.floor(Math.random()*HSKINS.length)]; } while(used&&used.has(h+s)&&++n<20); if(used) used.add(h+s);
    const k="hull-"+h+"--"+s; if(!hullImgs[k]){ const i=new Image(); i.src=HULL_BASE+k+".webp"; hullImgs[k]=i; } return {k,img:hullImgs[k],a:HULLS[h][0],nz:HULLS[h][1]}; }
  // a pilot's own skin from the Hangar collection (lib/collection: "<hull>--<paint>", art in /turbo/skins/)
  // fx = that copy's {burn 0..1, seed 0..999}: soot drawn over the paint, and a hue shift on pattern paints (lib/collection copyLook)
  const PATTERN=new Set(["nebula","marble-gilt","aurora","damascus","holo-foil"]);
  // art = {skin: url, geo: [aspect, nozzles]} for a skin the live catalogue added (not in this file)
  const okGeo=g=>Array.isArray(g)&&isFinite(g[0])&&g[0]>.1&&g[0]<2&&Array.isArray(g[1])&&g[1].length>0&&g[1].length<5&&g[1].every(n=>Array.isArray(n)&&n.length===3&&n.every(isFinite));
  const okSrc=u=>typeof u==="string"&&/^(https:\/\/|\/)[\w\-./%:]+\.(webp|png)$/i.test(u);
  function skinShip(id,fx,art){ const [h,paint]=String(id||"").split("--"); const geo=HULLS[h]||(art&&okGeo(art.geo)?art.geo:null); if(!geo) return null;
    const src=art&&okSrc(art.skin)?art.skin:(A.skinBase||"/turbo/skins/")+id+".webp";
    if(!hullImgs[src]){ const i=new Image(); i.src=src; hullImgs[src]=i; }
    const look=fx&&isFinite(fx.burn)?{hue:PATTERN.has(paint)?((fx.seed*37)%41)-20:0,soot:Math.min(.85,Math.max(0,(fx.burn-.05)*1.1)),seed:fx.seed|0}:null;
    return {k:id,img:hullImgs[src],a:geo[0],nz:geo[1],look,cv:null}; }
  // bake a copy's look into a canvas once the art has loaded (so drawing stays one drawImage a frame)
  function bake(hull){ const im=hull.img, L=hull.look, c=document.createElement("canvas"); c.width=im.naturalWidth; c.height=im.naturalHeight; const x=c.getContext("2d");
    if(L.hue) x.filter=`hue-rotate(${L.hue}deg)`; x.drawImage(im,0,0); x.filter="none";
    if(L.soot>0.01){ x.globalCompositeOperation="source-atop"; const g=x.createLinearGradient(0,0,0,c.height); g.addColorStop(0,`rgba(20,14,10,${L.soot*.35})`); g.addColorStop(.7,`rgba(20,14,10,${L.soot*.6})`); g.addColorStop(1,`rgba(10,6,4,${L.soot*.9})`);
      x.fillStyle=g; x.fillRect(0,0,c.width,c.height); let r=L.seed*9301+49297; const rr2=()=>((r=(r*9301+49297)%233280)/233280);
      for(let i=0;i<Math.round(L.soot*90);i++){ x.fillStyle=`rgba(8,5,3,${.25+rr2()*.4})`; x.beginPath(); x.arc(rr2()*c.width,c.height*(.35+rr2()*.65),1+rr2()*c.width*.03,0,7); x.fill(); } }
    return c; }
  // collection art: trails (6-frame plume + 3 particles, black = clear, drawn additively), name-tag plates, the win flourish
  const ART=A.art2||"/turbo/", artImgs={};
  const artImg=src=>{ if(!artImgs[src]){ const i=new Image(); i.src=/^(https:\/\/|\/)/.test(src)?src:ART+src; artImgs[src]=i; } return artImgs[src]; };
  const ready=i=>i&&i.complete&&i.naturalWidth>0;
  function trailFx(id,art){ const t=String(id||"").replace(/^trail-/,""); if(!/^[a-z0-9-]{1,24}$/.test(t)) return null;
    const own=art&&okSrc(art.plume)&&okSrc(art.bits);
    return {id:t,plume:artImg(own?art.plume:"trails/trail-"+t+"-plume.webp"),bits:artImg(own?art.bits:"trails/trail-"+t+"-bits.webp")}; }
  function tagFx(id){ const t=String(id||""); if(!/^tag-[a-z0-9-]{1,20}$/.test(t)||t==="tag-common") return null; return {img:artImg("tags/"+t+".webp"),pr:/prestige/.test(t)}; }
  // flames at each nozzle of a hull (or the chrome rocket's one), then the sprite; ctx is already at the rocket's centre
  function drawShip(c2,hull,img,h,fl,col,sq,tf,now){ if(!isFinite(fl)) fl=1; const w=hull?h*hull.a:h*221/609, fk=Math.min(1,h/120), nz=hull?hull.nz:[[.5,.97,1]];
    if(!isFinite(h+w)) return w;   // before the first layout
    c2.globalCompositeOperation="lighter";
    if(tf&&ready(tf.plume)){ const fw=tf.plume.naturalWidth/6, fh=tf.plume.naturalHeight, f=Math.floor((now||0)/70)%6;   // the trail's plume, flickering at ~14 fps
      for(const [nx,ny,ns] of nz){ const k=fk*ns, L=(90+70*Math.min(2.4,fl))*k, W2=L*fw/fh*1.7, x0=(nx-.5)*w, fy=(ny-.5)*h-L*.04;
        c2.drawImage(tf.plume,f*fw,0,fw,fh,x0-W2/2,fy,W2,L); } }
    else for(const [nx,ny,ns] of nz){ const x0=(nx-.5)*w, fy=(ny-.5)*h-h*.02, k=fk*ns; const g=c2.createRadialGradient(x0,fy,2,x0,fy+30*fl*k,72*fl*k); g.addColorStop(0,"rgba(255,250,235,.95)"); g.addColorStop(.25,`rgba(${col},.85)`); g.addColorStop(1,`rgba(${col},0)`);
      c2.fillStyle=g; c2.beginPath(); c2.ellipse(x0,fy+36*fl*k,(15*fl+5)*k,(60*fl+8)*k,0,0,Math.PI*2); c2.fill(); }
    c2.globalCompositeOperation="source-over"; c2.scale(1-sq*.3,1+sq);
    if(hull&&hull.look&&!hull.cv&&ready(hull.img)) hull.cv=bake(hull);
    const im=hull&&hull.cv?hull.cv:hull&&hull.img.complete&&hull.img.naturalWidth?hull.img:img, ww=im===img?h*221/609:w; if(im&&(im.tagName==="CANVAS"||im.complete)) c2.drawImage(im,-ww/2,-h/2,ww,h); return w; }
  { const u=`url("${A.art||"/art/modes/duel.webp"}")`; $("preBg").style.backgroundImage=u; $("preArt").style.backgroundImage=u; }   // the lobby hero: the whole duel art, your gold ship vs the pink one
  // Reduce motion = the phone's own setting, or the lobby gear's (lib/game/settings reduceFx, readPrefs below)
  const RM=matchMedia('(prefers-reduced-motion: reduce)').matches; let reduce=RM;
  const rnd=(a,b)=>a+Math.random()*(b-a);
  const gauss=()=>{let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
  const usd=(v,s)=>{ const a=Math.abs(v), sub=CLR&&a<.01;   // Climb's $1 levels move in fractions of a cent: show them ($0.004)
    if(!isFinite(v)||a<(sub?.0005:.005)) return "$0.00";   // and never "\u2212$0.00"
    return (s&&v>0?"+":"")+(v<0?"\u2212":"")+"$"+a.toFixed(sub?3:2); };
  const px=p=>p.toLocaleString("en-US",{minimumFractionDigits:1,maximumFractionDigits:1});
  const mmss=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");};

  /* ---------- rules ---------- */
  const DUEL_LEV=50 /* Lighter BTC max, feel test */, DUEL_FEE=0.000055 /* 0.55 bp a side = 1.1 bp round trip: Lighter Plus + 0.1 bp ours, locked (feel test, lib/duel/rules) */, FILL_MS=300 /* Lighter taker speed bump */, LIQ=0.8 /* NUKE at 80% of the fuel in it lost */;
  let LEV=DUEL_LEV, FEE=DUEL_FEE;   // Climb (host.climb) flies its own gear and fee per run
  let FUEL0=20;
  const TIERS={rookie:{fuel:20,sizes:[1,2,5,10,0]},pro:{fuel:50,sizes:[2,5,10,25,0]},shark:{fuel:150,sizes:[5,10,25,50,0]}};
  const BOTS={
    rookie:{name:"@moonboy",fuel:20,sizes:[1,2,5,10,0],react:[900,1700],cool:5000,thr:12,tp:.15,sl:-.4,noise:.12,stake:5,flip:.1,hold:[14000,30000],rate:4},
    pro:{name:"@solwhale",fuel:50,sizes:[2,5,10,25,0],react:[450,900],cool:4000,thr:10,tp:.3,sl:-.25,noise:.03,stake:10,flip:.25,hold:[12000,26000],rate:6},
    shark:{name:"@rektproof",fuel:150,sizes:[5,10,25,50,0],react:[250,520],cool:3000,thr:6,tp:.6,sl:-.2,noise:0,stake:30,flip:.4,hold:[9000,20000],rate:8},
  };
  /* Bot skill follows the pilot, not the fuel tier (maker 2026-11-18: "difficulty needs to scale with the user's rank").
     The tier only sets fuel and trade sizes. Skill 0..1 = hidden rating (1000 -> 0, 1500 -> 1), new pilots (under 5 online
     duels) start easy at .15, then each bot win nudges it up and each loss down (localStorage duel.botAdj, +-.35 max).
     Behaviour blends the old rookie (0) -> pro (.5) -> shark (1) bots. */
  const BOT_SKILL=[BOTS.rookie,BOTS.pro,BOTS.shark];
  function botAdj(){ try{ const v=+localStorage.getItem("duel.botAdj"); return isFinite(v)?Math.max(-.35,Math.min(.35,v)):0; }catch(e){ return 0; } }
  function botAdjBy(d){ try{ localStorage.setItem("duel.botAdj",String(Math.max(-.35,Math.min(.35,botAdj()+d)))); }catch(e){} }
  function botSkill(){ const r=REC||{}, games=(r.w||0)+(r.l||0), base=games<5?.15:((r.rating||1200)-1000)/500;
    return Math.max(0,Math.min(1,base+botAdj())); }
  function botCfg(){ const s=botSkill(), x=s*2, i=Math.min(1,Math.floor(x)), f=x-i, a=BOT_SKILL[i], b=BOT_SKILL[i+1];
    const L=(u,v)=>u+(v-u)*f, LL=(u,v)=>[L(u[0],v[0]),L(u[1],v[1])], fuel=TIERS[botKey].fuel;
    return {name:(s<.34?BOTS.rookie:s<.67?BOTS.pro:BOTS.shark).name, skill:s, react:LL(a.react,b.react), cool:L(a.cool,b.cool),
      thr:L(a.thr,b.thr), tp:L(a.tp,b.tp), sl:L(a.sl,b.sl), noise:L(a.noise,b.noise), flip:L(a.flip,b.flip), hold:LL(a.hold,b.hold),
      rate:L(a.rate,b.rate), stake:Math.max(1,Math.round(fuel*L(a.stake/a.fuel,b.stake/b.fuel)))}; }
  let botKey="pro", LEN=60000; // one length: 1 minute (maker, 2026-11-16: "3 minutes is way too long")
  try{botKey=localStorage.getItem("duel.tier")||botKey; if(!BOTS[botKey]) botKey="pro";}catch(e){}
  /* match: null, or {net:true, startAt, endAt, me:pid, opp:{pid,name}} for a live duel, or {net:false} for practice */
  let M=null, OFF=0; const now_=()=>Date.now()+OFF;
  /* Climb (solo Turbo, maker 2026-11-17): host.climb turns the duel into a solo run, no rival. CLR = the run being flown:
     {level, fuel, gear, goal (null in free mode), len} */
  const CL=host.climb||null; let CLR=null;

  /* ---------- state ---------- */
  let G=null;
  // a Hangar look: {skin, trail, tag, flourish, rgb, fx:{skin:{burn,seed,trak}, trail:{burn,seed}}}
  const FLOURISH_ART={"flourish-gold-rush":"flourish/win-flourish.webp"};
  function wearLook(pl,l){ const fx=l.fx||{}, art=l.art||null; pl.hull=skinShip(l.skin,fx.skin,art)||pl.hull;
    if(l.trail){ pl.tf=trailFx(l.trail,art); if(pl.tf&&fx.trail) pl.tf.seed=fx.trail.seed|0;
      if(l.rgb){ const b=fx.trail&&isFinite(fx.trail.burn)?Math.min(.6,fx.trail.burn*.7):0; pl.flameC=l.rgb.split(",").map(v=>Math.round(+v*(1-b)+90*b)).join(","); } }   // a burnt trail smokes greyer
    pl.tag=tagFx(l.tag); pl.trak=fx.skin&&fx.skin.trak!=null?fx.skin.trak:null; pl.fl=FLOURISH_ART[l.flourish]||(art&&okSrc(art.flourish)?art.flourish:null); }
  const PL=()=>G.bot?[G.me,G.bot]:[G.me];   // the pilots in this run (Climb: just you)
  function newPlayer(name,me){return {name,me,fuel:FUEL0,pos:null,fees:0,trades:0,up:0,dn:0,green:0,best:0,y:0,vy:0,flame:0,flameC:"255,200,120",sq:0,lastTrade:-1e9,next:0,moments:[]};}
  function newGame(){
    optim=0;
    FUEL0=curFuel(); LEV=CLR?CLR.gear:DUEL_LEV; FEE=CLR?CL.fee:DUEL_FEE; SIZES=PCTS; if(CLR&&CLR.free) stake=cPct>=100?0:cPct; else if(!SIZES.includes(stake)) stake=25; paintSizes(); resizeK();
    const startAt=M&&M.startAt||Date.now()+3500, h=host.history(), BCFG=botCfg();
    G={t:now_()-startAt,startAt,solo:!!CLR,len:CLR?CLR.len:(M&&M.endAt?M.endAt-startAt:LEN),ot:false,over:false,price:h.length?h[h.length-1].p:0,ticks:[],marks:[],
       me:newPlayer("you",true),bot:CLR?null:newPlayer(M&&M.opp?M.opp.name:BCFG.name,false),   // Climb flies alone (maker 2026-11-18: "there is no rival in this mode")
       cfg:BCFG,started:false};
    if(!G.bot){} else if(!(M&&M.opp&&!M.opp.bot)) G.bot.hull=hullFor();   // bots fly a random hull + skin
    else if(host.shipOf){ const os=host.shipOf(M.opp.pid); if(os) wearLook(G.bot,os); }   // a real rival flies their own look
    { const ms=host.myShip&&host.myShip(); if(ms) wearLook(G.me,ms); }   // your Hangar skin + trail + name tag + flourish
    for(const k of h) G.ticks.push({t:k.ts-startAt,p:k.p});
    if(!G.ticks.length) G.ticks.push({t:G.t,p:0});
  }
  function pushPrice(p,ts){
    if(!G||!(p>0)) return; const t=(ts||Date.now())-G.startAt;
    if(G.price===p&&G.ticks.length&&t-G.ticks[G.ticks.length-1].t<1000) return;
    G.price=p; G.ticks.push({t,p}); if(G.ticks.length>4000) G.ticks.splice(0,1000);
  }
  const pnlOf=(pos,p)=>pos?pos.size*(p-pos.entry)/pos.entry*pos.side:0;
  const valueOf=pl=>pl.pos?Math.max(0,pl.pos.coll+pnlOf(pl.pos,G.price)):0;
  const profitOf=pl=>pl.fuel+valueOf(pl)-FUEL0;

  /* ---------- trading ---------- */
  function vOpen(pl,side,stake,price){ if(side>0) pl.up++; else pl.dn++;   // boost / dump tally for the scoreboard
    G.marks.push({t:G.t,p:price,me:pl.me,k:side>0?"b":"d"});
    fxTrade(pl,side,stake);
    feed(pl,side>0?"b":"d",pl.me?`you ${side>0?"boosted":"dumped"} <b>$${stake.toFixed(0)}</b>`:`${esc(pl.name)} ${side>0?"boosted":"dumped"} <b>$${stake.toFixed(0)}</b>`);
    pl.lastTrade=G.t;
  }
  function vClose(pl,side,net,price){
    if(!pl.me&&net>0&&Math.random()<.45&&!(M&&M.net)) setTimeout(()=>trick(pl,Math.random()<.5?"spin":"flip"),350);
    G.marks.push({t:G.t,p:price,me:pl.me,k:"x"});
    moment(pl,`${pl.me?"you":esc(pl.name)} cashed out a ${side>0?"BOOST":"DUMP"}`,net);
    popAt(pl,usd(net,true),net>=0?"#5FF0A0":"#FF8FBD");
    feed(pl,net>=0?"g":"r",`${pl.me?"you":esc(pl.name)} banked <b>${usd(net,true)}</b>`);
    if(pl.me){ sfx(net>=0?"win":"lose"); buzz(net>=0?[12,30,12]:[30]); }
    pl.lastTrade=G.t;
    // Climb: banking the goal is the finish line, the run ends there (maker 2026-11-18)
    if(pl.me&&G.solo&&CLR&&CLR.goal!=null) setTimeout(()=>{ if(G&&G.solo&&!G.over&&!G.me.pos&&cHit(profitOf(G.me))) end(); },900);
  }
  const cHit=v=>CLR&&CLR.goal!=null&&Math.round(v*100)>=Math.round(CLR.goal*100);
  function vBomb(pl,side,lost,price){
    G.marks.push({t:G.t,p:price,me:pl.me,k:"x"});
    moment(pl,`${pl.me?"you":esc(pl.name)} got NUKED on a ${side>0?"BOOST":"DUMP"}`,-lost);
    fxBomb(pl); feed(pl,"r",`${pl.me?"you":esc(pl.name)} got <b>NUKED</b>`);
    if(pl.me&&G.solo){ G.nuked=true; if(pl.fuel<minT()) setTimeout(()=>{ if(G&&G.solo&&!G.over) end(); },1400); }   // Climb: out of fuel ends the run
    if(pl.me){sfx("bomb");buzz([60,40,90]);} else sfx("bomb",.5,(lane(pl)/SW)*2-1);
  }
  function open(pl,side,stake,why){
    if(!(G&&G.price>0)){ if(pl.me) toast("Waiting for the live BTC price\u2026"); return false; }
    stake=Math.min(stake,pl.fuel/(1+LEV*FEE));
    if(stake<(pl.me?minT():1)){ if(pl.me) fuelOut(); return false; }
    const size=stake*LEV, fee=size*FEE;
    pl.fuel-=stake+fee; pl.fees+=fee; pl.trades++;
    if(pl.pos&&pl.pos.side===side){
      const s2=pl.pos.size+size; pl.pos.entry=s2/(pl.pos.size/pl.pos.entry+size/G.price); pl.pos.size=s2; pl.pos.coll+=stake;
    } else pl.pos={side,size,coll:stake,entry:G.price,t:G.t};
    vOpen(pl,side,stake,G.price); return true;
  }
  function close(pl,why){
    if(!pl.pos) return 0;
    const pos=pl.pos, pnl=pnlOf(pos,G.price), fee=pos.size*FEE, back=Math.max(0,pos.coll+pnl-fee), net=back-pos.coll;
    pl.fuel+=back; pl.fees+=fee; pl.trades++; pl.pos=null;
    if(net>0) pl.green++;
    if(net>pl.best) pl.best=net;
    vClose(pl,pos.side,net,G.price); return net;
  }
  function liquidate(pl){
    const pos=pl.pos; pl.pos=null; pl.trades++;
    vBomb(pl,pos.side,pos.coll,G.price);
  }
  function moment(pl,txt,v){ (pl.me?G.me:G.bot).moments.push({t:G.t,txt,v}); }

  /* player actions */
  // trade size = a share of the duel fuel you have left (maker 2026-11-17, like Sell % in live flight); 0 = ALL
  const PCTS=[10,25,50,0]; let stake=25, SIZES=PCTS, cPct=25;   // cPct: Climb free mode's size slider, 1-100%
  const pctUsd=(pc,f)=>pc===0?f:Math.floor(f*pc)/100;   // whole cents, rounded down
  const minT=()=>CLR?.1:1;   // smallest trade: Climb 10 cents (Lighter has no minimum, maker 2026-11-18: ".10 minimum to limit spam"); duels keep the server $1
  // Climb on Lighter: a bet under Lighter's smallest order (host.climb.lighter.minUsd, a position in $) goes out at that
  // minimum, so the button shows the real amount (maker 2026-11-18: "if its .25 not show .5"); 0 = can't (fuel too low)
  const lxMin=()=>CLR&&CL&&CL.lighter&&CL.lighter.minUsd>0?CL.lighter.minUsd/LEV:0;
  const realUsd=(pc,f)=>{ const d=pctUsd(pc,f), m=lxMin(); if(!m||pc===0||!(d>0)) return d; const r=Math.ceil(m*100)/100; return d>=r?d:(f>=r?r:0); };
  const stakeUsd=()=>realUsd(stake,G&&G.me?G.me.fuel:FUEL0);   // open() keeps the fee back
  /* custom budgets (friend duels): same rule as lib/duel/rules sizesFor. Sizes = half the budget on a 1-2-5 step, then three steps down. */
  const BUD_MIN=5, BUD_MAX=10000, okBud=v=>Number.isInteger(v)&&v>=BUD_MIN&&v<=BUD_MAX;
  const money=v=>v<1?"$"+v.toFixed(2):v>=1000?"$"+(v%1000?(v/1000).toFixed(1).replace(/\.0$/,""):v/1000)+"K":"$"+v;
  function sizesFor(f){ const nice=v=>{ if(v<1) return 1; const k=10**Math.floor(Math.log10(v)), m=v/k; return (m>=5?5:m>=2?2:1)*k; };
    const down=v=>{ const k=10**Math.floor(Math.log10(v)), m=Math.round(v/k); return m===5?2*k:m===2?k:5*(k/10); };
    if(f<20) return [1,2,3,Math.max(4,Math.floor(f/2)),0];   // under $20: whole dollars, the $1 minimum trade
    const out=[nice(f/2)]; while(out.length<4) out.unshift(down(out[0])); return [...out,0]; }
  function curFuel(){ if(CLR) return CLR.fuel; return M&&M.fuel&&okBud(M.fuel)?M.fuel:TIERS[botKey].fuel; }
  function curSizes(){ return M&&M.fuel&&okBud(M.fuel)?sizesFor(M.fuel):TIERS[botKey].sizes; }
  function paintSizes(){ const f=G&&G.me?G.me.fuel:FUEL0; document.querySelectorAll(".size button").forEach(b=>{const v=SIZES[+b.dataset.i]; if(v==null){ b.hidden=true; return; } const d=realUsd(v,f);
    b.innerHTML=(v===0?"ALL":v+"%")+`<span class="u">${d>=minT()?"$"+(d>=10?Math.floor(d):d.toFixed(2).replace(/\.00$/,"")):"\u2013"}</span>`; b.classList.toggle("on",v===stake); b.classList.toggle("lo",d<minT());});
    const sl=$("cSlI"); if(sl&&CLR&&CLR.free){ const pc=stake===0?100:stake, d=realUsd(stake,f); if(+sl.value!==pc) sl.value=pc; sl.style.setProperty("--p",pc+"%");
      $("cSlV").innerHTML=`${pc}%<span class="u">${d>=minT()?"$"+(d>=10?Math.floor(d):d.toFixed(2)):"\u2013"}</span>`; } }
  function act(kind){
    if(!G||!G.started||G.over) return;
    if(!(G.price>0)){ toast("Waiting for the live BTC price\u2026"); return; }
    const me=G.me;
    if(M&&M.net){
      if(kind==="x"&&!me.pos){toast("Nothing open.");return;}
      if(kind==="f") return;
      if((kind==="b"||kind==="d")&&me.pos&&me.pos.side!==(kind==="b"?1:-1)){ fuelOut(me.pos.side); return; }
      const action=kind==="b"?"boost":kind==="d"?"dump":"close", amt=stake===0?0:stakeUsd();
      // the press shows at once at the price you see (maker 2026-11-18: no waiting on the fill); the server's echo then
      // sets the real book, and a refused press puts the book back
      const snap=bookOf(me);
      const ok=action==="close"?close(me)!==0||!me.pos:open(me,kind==="b"?1:-1,stake===0?me.fuel:amt);
      if(!ok) return;
      optim++; ui();
      host.trade(action,amt,SIZES.indexOf(stake),me.fuel).then(r=>{ if(r&&r.error){ if(optim>0) optim--; setBook(me,snap); ui(); toast(r.error); } });
      return;
    }
    if(filling) return;   // one order in flight at a time
    if(kind==="b"||kind==="d"){
      const side=kind==="b"?1:-1;
      // no flips (maker 2026-11-17, Nova fills are slow): the other side waits for a cash out
      if(me.pos&&me.pos.side!==side){ fuelOut(me.pos.side); return; }
      const amt=stake===0?me.fuel:stakeUsd();
      clx(kind==="b"?"boost":"dump",Math.max(0,me.fuel-amt));
      fillLater(()=>{ if(!(me.pos&&me.pos.side!==side)) open(me,side,stake===0?me.fuel:amt); });
    } else if(kind==="x"){
      if(!me.pos){toast("Nothing open.");return;}
      clx("close",me.fuel+me.pos.coll);
      fillLater(()=>close(me));
    }
  }
  // practice fills land FILL_MS after the tap, at the price then (like a Lighter taker order)
  let filling=false;
  function fillLater(fn){ filling=true; setTimeout(()=>{ filling=false; if(!G||!G.started||G.over) return; fn(); ui(); if(CLR&&CL.lighter) CL.lighter.fuel(G.me.fuel); },FILL_MS); }
  // Climb on Lighter (host.climb.lighter, hidden flag): the press goes out as a real order at the tap
  function clx(action,fuelAfter){ if(!CLR||!CL||!CL.lighter) return;
    CL.lighter.press(action,SIZES.indexOf(stake)>=0?SIZES.indexOf(stake):(stake===0?3:stake>=38?2:stake>=18?1:0),fuelAfter).then(r=>{ if(r&&r.error) toast(r.error); }); }

  /* ---------- live duel: server events ---------- */
  function setBook(pl,b){ pl.fuel=b.fuel; pl.pos=b.pos?Object.assign({},b.pos):null; pl.fees=b.fees; pl.trades=b.trades; pl.green=b.green; pl.best=b.best; }
  const bookOf=pl=>({fuel:pl.fuel,pos:pl.pos?Object.assign({},pl.pos):null,fees:pl.fees,trades:pl.trades,green:pl.green,best:pl.best});
  let optim=0;   // presses already shown on screen, waiting for the server's echo
  function onEvent(ev){
    if(!G||!M||!M.net) return;
    const pl=ev.pid===M.me?G.me:G.bot;
    if(ev.type==="trade"||ev.type==="bomb"){
      const shown=pl.me&&ev.type==="trade"&&optim>0; if(shown) optim--;   // its burst already played at the press
      for(const st of ev.steps){ if(st.kind==="open"){ if(!shown) vOpen(pl,st.side,st.usd,st.price); } else if(st.kind==="close"){ if(!shown) vClose(pl,st.side,st.net,st.price); } else vBomb(pl,st.side,st.lost,st.price); }
      setBook(pl,ev.book); pushPrice(ev.price,ev.ts); ui();
    } else if(ev.type==="chat"){ say(pl,ev.text); }
    else if(ev.type==="trick"){ if(!pl.me) trick(pl,ev.kind); }
    else if(ev.type==="overtime"){ G.ot=true; G.len=ev.endAt-G.startAt; toast("Overtime! 30 more seconds."); sfx("ot"); bed("amb_tension"); }
    else if(ev.type==="leave"){ if(!pl.me) toast(`${esc(G.bot.name)} left. Their trades still count.`); }
    else if(ev.type==="end"){ endNet(ev.result); }
  }
  /* ---------- the bot ---------- */
  function botThink(){
    const b=G.bot, c=G.cfg; if(G.t<b.next) return;
    b.next=G.t+rnd(c.react[0],c.react[1]);
    const p=G.price, past=priceAt(G.t-2500), m=p-past, mShort=p-priceAt(G.t-900);
    // scale the move it reacts to by how busy the tape is (quiet BTC moves a few $ a second, loud BTC tens)
    let mv=0,nm=0; for(let t=G.t-20000;t<G.t;t+=2500){ mv+=Math.abs(priceAt(t+2500)-priceAt(t)); nm++; } mv=nm?mv/nm:c.thr;
    const thr=Math.max(1,Math.min(c.thr,mv*1.3));
    if(!b.hold) b.hold=rnd(c.hold[0],c.hold[1]);
    if(b.pos){
      const pnl=(pnlOf(b.pos,p)-b.pos.size*FEE)/b.pos.coll*5;
      const against=Math.sign(m)===-b.pos.side&&Math.abs(m)>thr;
      // a stale seat only closes in the green (or now and then), so the bot isn't paying fees to churn flat trades
      const stale=G.t-b.pos.t>b.hold&&(pnl>0||Math.random()<.2);
      if(pnl>=c.tp*5||pnl<=c.sl*5||(against&&Math.random()<.6)||(stale&&Math.random()<.5)||(G.len-G.t<4000&&pnl>0)){
        b.hold=0;
        const side=b.pos.side; close(b);
        if(against&&Math.random()<c.flip&&botRoom(b,c)) { b.opens=(b.opens||0)+1; open(b,-side,c.stake); }
      }
      return;
    }
    if(G.t-b.lastTrade<c.cool||!botRoom(b,c)) return;
    if(Math.random()<c.noise){ b.opens=(b.opens||0)+1; open(b,Math.random()<.5?1:-1,c.stake); return; }
    if(Math.abs(m)>thr&&Math.sign(mShort)!==-Math.sign(m)){ b.opens=(b.opens||0)+1; open(b,Math.sign(m),Math.abs(m)>thr*1.8?c.stake*2:c.stake); }
  }
  // at most c.rate new seats a minute (plus a couple to start): a real pilot picks spots, it doesn't spray
  function botRoom(b,c){ return (b.opens||0)<2+c.rate*G.t/60000; }
  function priceAt(t){ for(let i=G.ticks.length-1;i>=0;i--) if(G.ticks[i].t<=t) return G.ticks[i].p; return G.ticks[0].p; }

  /* ---------- loop ---------- */
  let last=0, cdUntil=0; const preEl=$("pre");
  function frame(now){
    const dt=Math.min(.05,(now-(last||now))/1000); last=now;
    humTick(!!(G&&G.started&&!G.over), G&&G.me?Math.min(1,(G.me.flame||0)/2.2):0);
    if(G&&G.started&&!G.over&&G.bot&&!G.solo){ const ld=profitOf(G.me)-profitOf(G.bot), side=ld>0.05?1:ld<-0.05?-1:0; if(side&&G.leadSide&&side!==G.leadSide&&now>(G.leadAt||0)){ G.leadAt=now+2500; sfx("lead"); } if(side) G.leadSide=side; }
    if(G&&G.started&&!G.over){
      G.t=now_()-G.startAt;
      if(!(M&&M.net)){
      for(const pl of PL()) if(pl.pos&&pnlOf(pl.pos,G.price)<=-LIQ*pl.pos.coll) liquidate(pl);
      if(!G.solo) botThink();
      }
      if(!(M&&M.net)&&G.t>=G.len&&G.solo) end();
      else if(!(M&&M.net)&&G.t>=G.len){
        const d=profitOf(G.me)-profitOf(G.bot);
        if(!G.ot&&Math.abs(d)<0.25*FUEL0/20){ G.ot=true; G.len+=30000; toast("Overtime! 30 more seconds."); sfx("ot"); bed("amb_tension"); }
        else end();
      }
      ui();
    }
    if(G&&!G.started) G.t=now_()-G.startAt;
    if(preEl.hidden||preEl.classList.contains("out")){ drawSky(dt,now); if(!G||!G.chartAt||now-G.chartAt>60){ drawChart(); if(G)G.chartAt=now; } }
    if(!dead) requestAnimationFrame(frame);
  }

  /* ---------- UI ---------- */
  // "\u25b23 \u25bc1": boosts in gold, dumps in pink (each press that opens or adds counts once)
  const tally=pl=>`<span style="color:var(--gold)">\u25b2${pl.up}</span> <span style="color:var(--pinkl)">\u25bc${pl.dn}</span>`;
  function ui(){
    const me=G.me,b=G.bot||G.me, pm=profitOf(me), pb=profitOf(b), d=pm-pb;
    $("meP").textContent=usd(pm,true); $("meP").style.color=pm>0?"var(--green)":pm<0?"var(--pinkl)":"var(--text)";
    $("botP").textContent=usd(pb,true); $("botP").style.color=pb>0?"var(--green)":pb<0?"var(--pinkl)":"var(--text)";
    if(!G.solo){ $("meN").innerHTML=tally(me); $("botN").innerHTML=tally(b); }
    $("clock").textContent=mmss(Math.min(G.len,G.len-G.t)); $("mid").classList.toggle("ot",G.ot);
    const w=Math.min(50,Math.abs(d)*25); const li=$("leadI");
    li.style.left=d>=0?(50-w)+"%":"50%"; li.style.width=w+"%";   // the bar leans toward whoever leads (you: left, rival: right) li.style.background=d>=0?"var(--green)":"var(--pink)";
    $("leadT").textContent=Math.abs(d)<0.005?"EVEN":(d>0?"UP ":"DOWN ")+"$"+Math.abs(d).toFixed(2);
    $("leadT").style.color=Math.abs(d)<0.005?"var(--muted)":d>0?"var(--green)":"var(--pinkl)";
    const pos=me.pos, el=$("bOut");
    if(pos){
      const pnl=pnlOf(pos,G.price), pct=pnl/pos.coll*100, back=Math.max(0,pos.coll+pnl-pos.size*FEE);
      $("posLab").textContent=`${pos.side>0?"BOOST \u25b2":"DUMP \u25bc"} ${LEV}\u00d7 \u00b7 $${pos.coll.toFixed(0)} IN`;
      $("posV").textContent=usd(pnl,true); const e=$("pnlP"); e.hidden=false; e.textContent=(Math.abs(pct)<.05?"":pct>0?"+":"\u2212")+Math.abs(pct).toFixed(1)+"%";   // no "\u22120.0%"
      $("bOutS").textContent=`CASH OUT ${usd(back)}`;
      el.classList.toggle("up",pnl>=0); el.classList.toggle("dn",pnl<0); el.disabled=false;
    } else {
      $("posLab").textContent=G.solo?"FUEL":"DUEL FUEL"; $("posV").textContent=usd(me.fuel); $("pnlP").hidden=true;
      $("bOutS").textContent=""; el.classList.remove("up","dn"); el.disabled=true;
    }
    const lb=pos&&pos.side<0, ld=pos&&pos.side>0;
    const su=stakeUsd(), amt=stake===0?"all":"$"+(su>=10?Math.floor(su):su.toFixed(2).replace(/\.00$/,""));
    $("bBoostS").textContent="BOOST"; $("bBoostA").textContent=lb?"":pos?(stake===0?"+ALL":"+"+amt):amt;   // no coaching sublines (maker 2026-11-18): the dimmed side and the fuel callout say it
    $("bDumpS").textContent="DUMP"; $("bDumpA").textContent=ld?"":pos?(stake===0?"+ALL":"+"+amt):amt;
    $("bBoost").classList.toggle("off",!!lb); $("bDump").classList.toggle("off",!!ld);
    paintSizes();
    if(G.solo) soloUi();
  }
  function feed(pl,k,html){
    const f=$("feed"), d=document.createElement("div"); d.className="ev";
    if(k==="c"){ d.className="ev say"+(pl.me?"":" them"); }
    const bg={b:"var(--gold)",d:"var(--pink)",g:"var(--green)",r:"var(--pink)",t:"#8FE3FF",c:pl.me?"var(--gold)":"var(--pink)"}[k], ic={b:"\u25b2",d:"\u25bc",g:"$",r:"!",t:"\u2605",c:"\u201c"}[k];
    d.innerHTML=`<i style="background:${bg};color:${k==="d"||k==="r"?"#fff":"#121327"}">${ic}</i><span>${html}</span>`;
    f.prepend(d); while(f.children.length>3) f.lastChild.remove();
    if(M&&M.net) return;
    if(G&&G.bot&&!G.over&&pl===G.bot&&k==="g"&&Math.random()<.35) botSay(pick(["ez","too slow","thanks for the liquidity","\ud83d\udcc8","read that one"]),900);
    if(G&&G.bot&&!G.over&&pl===G.me&&k==="g"&&Math.random()<.2) botSay(pick(["lucky","ok ok","nice one","won't happen again"]),1200);
    if(G&&G.bot&&!G.over&&pl===G.me&&k==="t"&&Math.random()<.5) botSay(pick(["lol","show off","\ud83d\ude02","spin all you want"]),900);
  }
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  const esc=t=>t.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const QUICK=["gg","nice trade","\ud83d\ude80","rekt","lol","wp","\ud83d\udc40","catch me"];
  let chatMute=false; try{ chatMute=localStorage.getItem("duel.chatMute")==="1"; }catch(e){}
  function say(pl,txt){
    txt=txt.trim().slice(0,60); if(!txt||!G) return;
    if(!pl.me&&chatMute) return;
    pl.say={txt,until:performance.now()+3200};
    feed(pl,"c",`<b>${pl.me?"you":esc(pl.name)}</b> ${esc(txt)}`);
    if(!pl.me&&$("chat").hidden) $("chatDot").hidden=false;
    sfx("tick");
  }
  let botSayT=0; function botSay(txt,delay){ if(G&&G.solo) return; clearTimeout(botSayT); botSayT=setTimeout(()=>{ if(G&&!G.over||txt==="gg") say(G.bot,txt); },delay||rnd(900,2000)); }
  function meSay(txt){
    if(M&&M.net){ host.chat(txt).then(r=>{ if(r&&r.error) toast(r.error); }); return; }
    say(G.me,txt);
    const t=txt.toLowerCase(), lead=profitOf(G.me)-profitOf(G.bot);
    if(Math.random()<.65) botSay(/gg|wp/.test(t)?pick(["gg","gg wp"]):/rekt|lol|\ud83d\ude02/.test(t)?(lead>0?pick(["it's not over","watch this"]):pick(["you're the one down","check the board"])):/catch|\ud83d\ude80/.test(t)?pick(["on my way","see you up there","\ud83d\ude80\ud83d\ude80"]):pick(["\ud83d\udc40","focus up","less talking more trading","ok"]));
  }
  // out of fuel (maker 2026-11-17: the plain toast was "bad"): a game callout over the trade bar pointing at CASH OUT, and the pill pulses.
  // Server errors with the same words land here too (toast below).
  // the same callout covers "Cash out first" (BOOST open and you hit DUMP, or the other way; maker 2026-11-18: the toast was old design)
  let fuelT=0; function fuelOut(open){
    let n=$("fuelOut"); const bar=document.querySelector(".duel-root .bottom");
    if(!n&&bar){ n=document.createElement("div"); n.id="fuelOut"; n.className="fuelout"; n.setAttribute("role","status"); bar.prepend(n); }
    if(n) n.innerHTML=open?`<b>${open>0?"\u25b2 BOOST":"\u25bc DUMP"} OPEN</b><span>CASH OUT \u25bc</span>`:'<b><i aria-hidden="true"></i>OUT OF FUEL</b><span>CASH OUT \u25bc</span>';
    const o=$("bOut"); for(const el of [n,o]) if(el){ el.classList.remove("show","nudge"); void el.offsetWidth; }
    if(n) n.classList.add("show"); if(o) o.classList.add("nudge"); $("toast").classList.remove("show"); buzz([30,40,30]);
    clearTimeout(fuelT); fuelT=setTimeout(()=>{ if(n) n.classList.remove("show"); if(o) o.classList.remove("nudge"); },2200); }
  let toastT=0; function toast(m){ if(/^out of duel fuel/i.test(m)){ fuelOut(); return; } if(/^cash out first/i.test(m)&&G&&G.me&&G.me.pos){ fuelOut(G.me.pos.side); return; } const t=$("toast");t.textContent=m;t.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove("show"),1800);}

  /* ---------- chart ---------- */
  const cc=$("cc"), cx=cc.getContext("2d");
  function drawChart(){
    if(!G) return;
    const w=cc.clientWidth,h=cc.clientHeight; if(!w) return; const d=Math.min(2,devicePixelRatio||1);
    if(cc.width!==Math.round(w*d)||cc.height!==Math.round(h*d)){cc.width=Math.round(w*d);cc.height=Math.round(h*d);}
    cx.setTransform(d,0,0,d,0,0); cx.clearRect(0,0,w,h);
    // the window starts where the price data does (after any long gap in the feed), so a short history fills the card
    // instead of hugging the right edge; it grows to the last 60 s once there's that much
    // phones see the last 30 s so each tick and the live price are easier to read; wider screens keep 60 s
    const WIN=w<600?20000:30000;   // tighter tape so each move reads big (maker 2026-11-17: "feel like moves are happening")
    const now=G.t; let T0=G.ticks.findIndex(k=>k.t>=now-WIN); if(T0<0) T0=G.ticks.length-1; T0=Math.max(0,T0);
    for(let i=G.ticks.length-1;i>T0;i--) if(G.ticks[i].t-G.ticks[i-1].t>10000){ T0=i; break; }
    const from=Math.max(now-WIN,Math.min(G.ticks[T0].t,now-Math.min(20000,WIN))), span=now-from;
    const pts=G.ticks.slice(Math.max(0,T0-1));
    let lo=Infinity,hi=-Infinity; pts.forEach(k=>{lo=Math.min(lo,k.p);hi=Math.max(hi,k.p);});
    for(const pl of PL()) if(pl.pos){lo=Math.min(lo,pl.pos.entry);hi=Math.max(hi,pl.pos.entry);}
    // the live price sits in the middle of the card, across and up/down (maker 2026-11-16: "the latest price should be in the
    // center, it would be easier to see"): the tape runs from the left edge to the centre, and the scale is even around it
    // the scale fits the last 20 s (12 s on phones), not the whole tape, so a $5 move fills the card (maker 2026-11-17:
    // "the price was barely moving ... just going sideways"); it eases in and out instead of jumping, never tighter than
    // ~0.008% of the price (about $5 on BTC), and older ticks or far entry lines run off the card's edge
    const RW=w<600?6000:10000; let rlo=G.price,rhi=G.price;
    for(let i=G.ticks.length-1;i>=0&&G.ticks[i].t>=now-RW;i--){ const p=G.ticks[i].p; if(p<rlo) rlo=p; if(p>rhi) rhi=p; }
    const tgt=Math.max((Math.max(G.price-rlo,rhi-G.price))*1.3,G.price*.00002,.5);   // floor ~$3 on BTC (was ~$8: felt flat, maker 2026-11-17)
    G.yh=!G.yh?tgt:G.yh+(tgt-G.yh)*(tgt>G.yh?.5:.15); lo=G.price-G.yh; hi=G.price+G.yh;
    const L=8,Rr=w<600?62:66,T=24,B=8, XM=Math.round(w*.5), X=t=>L+Math.max(0,(t-from))/span*(XM-L), Y=p=>T+(1-(p-lo)/(hi-lo))*(h-T-B);
    const x0=Math.max(L,Math.min(w-Rr,X(0))), pre=G.started&&x0>L+1;   // the match tape starts at GO; anything before it is grey
    const first=G.started?priceAt(0):pts[0].p, lastp=G.price, up=lastp>=first, col=up?"95,240,160":"240,48,127";
    // grid
    cx.font="500 10px "+GU+",sans-serif"; cx.fillStyle="rgba(215,217,228,.6)"; cx.textAlign="left"; cx.textBaseline="middle";
    const step=niceStep((hi-lo)/3);
    for(let v=Math.ceil(lo/step)*step; v<hi; v+=step){const y=Y(v); cx.strokeStyle="rgba(255,255,255,.07)"; cx.setLineDash([3,5]); cx.beginPath(); cx.moveTo(L,y); cx.lineTo(w-Rr,y); cx.stroke(); cx.setLineDash([]); cx.fillText(Math.round(v).toLocaleString("en-US"),w-Rr+8,y);}
    // stepped line + area (clipped to the plot, since older ticks can sit past the scale)
    cx.save(); { const cp=new Path2D(); cp.rect(0,T-3,w,h-T+3); cx.clip(cp); }
    cx.beginPath(); let py=null;
    pts.forEach((k,i)=>{const x=X(k.t),y=Y(k.p); if(!i){cx.moveTo(L,y); cx.lineTo(x,y);} else {cx.lineTo(x,py); cx.lineTo(x,y);} py=y;});
    const lx=X(now), ly=Y(lastp); cx.lineTo(lx,ly);
    cx.lineWidth=2.5; cx.lineJoin="miter";
    const clipX=(a,b,f)=>{ cx.save(); const pth=new Path2D(); pth.rect(a,0,b-a,h); cx.clip(pth); f(); cx.restore(); };
    if(pre) clipX(0,x0,()=>{ cx.strokeStyle="rgba(215,217,228,.38)"; cx.lineWidth=2; cx.stroke(); });
    clipX(pre?x0:0,w,()=>{ cx.strokeStyle=`rgb(${col})`; cx.stroke(); });
    cx.lineTo(lx,h); cx.lineTo(L,h); cx.closePath();
    const g=cx.createLinearGradient(0,T,0,h); g.addColorStop(0,`rgba(${col},.30)`); g.addColorStop(1,`rgba(${col},0)`);
    clipX(pre?x0:0,w,()=>{ cx.fillStyle=g; cx.fill(); });
    if(pre){ cx.setLineDash([4,4]); cx.strokeStyle="rgba(242,193,78,.7)"; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(x0,T); cx.lineTo(x0,h); cx.stroke(); cx.setLineDash([]);
      cx.font="700 11px "+GF+",sans-serif"; cx.fillStyle="rgba(242,193,78,.9)"; const rt=x0>L+40; cx.textAlign=rt?"right":"left"; cx.textBaseline="top"; cx.textBaseline="bottom"; cx.fillText("GO",x0+(rt?-4:4),h-B-2); }
    // entry lines
    const entry=(pl,color,label,below)=>{ if(!pl.pos) return; const raw=Y(pl.pos.entry), y=Math.max(T,Math.min(h-B,raw));
      if(label&&raw<T){ label="\u25b2 "+label; below=true; } else if(label&&raw>h-B){ label="\u25bc "+label; below=false; } else if(y<T+16) below=true;
      cx.setLineDash(pl.me?[5,4]:[3,4]); cx.strokeStyle=color; cx.lineWidth=pl.me?1.5:1; cx.beginPath(); cx.moveTo(L,y); cx.lineTo(w-Rr,y); cx.stroke(); cx.setLineDash([]);
      if(!label) return; cx.font="700 11px "+GF+",sans-serif"; cx.fillStyle=color; cx.textAlign=pl.me?"left":"right"; cx.textBaseline=below?"top":"bottom"; cx.fillText(label,pl.me?L+2:w-Rr-4,below?y+2:y-2); };
    if(G.bot) entry(G.bot,"rgba(185,188,203,.75)","",true);   // rival: line only (their trades are in the feed and the dots)
    entry(G.me,"rgba(242,193,78,.95)",`YOU ${G.me.pos&&G.me.pos.side>0?"BOOSTED":"DUMPED"}`,false);
    // trade dots
    // yours are round, the rival's are diamonds; both the same size so you can read their timing
    G.marks.forEach(k=>{ if(k.t<from) return; const x=X(k.t),y=Y(k.p); cx.beginPath();
      if(k.me) cx.arc(x,y,5.5,0,Math.PI*2); else { const r=6.5; cx.moveTo(x,y-r); cx.lineTo(x+r,y); cx.lineTo(x,y+r); cx.lineTo(x-r,y); cx.closePath(); }
      cx.fillStyle=k.k==="x"?"#FFFFFF":k.k==="b"?(k.me?"#F2C14E":"#5FF0A0"):(k.me?"#F0307F":"#FF8FBD"); cx.fill();
      cx.lineWidth=2; cx.strokeStyle="#121327"; cx.stroke(); });
    cx.restore();
    // live dot + price tag, right beside it in the middle; a faint line carries the price on to the scale
    cx.setLineDash([2,5]); cx.strokeStyle=`rgba(${col},.45)`; cx.lineWidth=1; cx.beginPath(); cx.moveTo(lx,ly); cx.lineTo(w-Rr,ly); cx.stroke(); cx.setLineDash([]);
    if(!reduce){ const pr=(performance.now()%1400)/1400; cx.strokeStyle=`rgba(${col},${(1-pr)*.7})`; cx.lineWidth=2; cx.beginPath(); cx.arc(lx,ly,4.5+pr*10,0,Math.PI*2); cx.stroke(); }
    cx.fillStyle=`rgb(${col})`; cx.beginPath(); cx.arc(lx,ly,5,0,Math.PI*2); cx.fill();
    const tag=px(lastp); cx.font="800 16px "+GF+",sans-serif";
    const tw=cx.measureText(tag).width+14, ty=Math.max(T-4,Math.min(h-B-22,ly-11)); cx.fillStyle=`rgb(${col})`; cx.beginPath(); cx.roundRect?cx.roundRect(lx+12,ty,tw,22,7):cx.rect(lx+12,ty,tw,22); cx.fill();
    cx.fillStyle=up?"#0d2a1b":"#fff"; cx.textAlign="center"; cx.textBaseline="middle"; cx.fillText(tag,lx+12+tw/2,ty+11.5);
    const ch=(lastp-first), cs=`<em class="${ch>=0?"up":"dn"}">${ch>=0?"+":"\u2212"}$${Math.abs(ch).toFixed(1)}</em>`, lt=G.started?`BITCOIN \u00b7 SINCE GO ${cs}`:`BITCOIN \u00b7 LAST ${Math.round(span/1000)}S ${cs}`;
    if(G.chLt!==lt){ G.chLt=lt; $("chLab").innerHTML=lt; }
  }
  function niceStep(r){const p=Math.pow(10,Math.floor(Math.log10(r)));const n=r/p;return (n<1.5?1:n<3.5?2:n<7.5?5:10)*p;}
  function toggleChart(){if(host.embed) return; $("app").classList.toggle("big"); $("chart").setAttribute("aria-label",$("app").classList.contains("big")?"BTC tick chart. Tap to make it smaller.":"BTC tick chart, last 60 seconds. Tap to make it bigger.");}
  $("chart").addEventListener("click",toggleChart);

  /* ---------- sky: the rocket race ----------
   * Altitude = profit. Each $1 of profit is K px of climb. The camera follows the pair, so a rocket that is winning
   * keeps climbing past altitude marks and through the sky layers, and a losing one drops back toward the pad.
   * If the gap gets too big for the screen, the camera zooms out. */
  const sky=$("sky"), sx=sky.getContext("2d"); let SW=0,SH=0,DPR=1;
  const FX={parts:[],pops:[],rings:[],shake:0,flash:0,flashC:"255,255,255"};
  let stars=[], cam={y:0,vy:0,z:1}, K=200; const FLY=flySky(rnd,reduce);   // world px per $ (only for the springs)
  /* a different sky every duel, never the same one twice in a row (maker 2026-11-15). Each sky is a stack of layers the
   * race climbs through, plus an optional colour grade. Ranked and friend duels pick from the room's start time, so both
   * pilots usually fly the same sky; bot duels pick at random. */
  /* the race is a journey (maker 2026-11-16: "it feels like a race and a journey"): the sky moves through the theme's
   * layers on the race clock, from the ground toward space, and the last 12 seconds are always the same final sky,
   * THE MOON, whatever theme you got. Flying up or down nudges you a little ahead or behind on the way. */
  const FINAL_SKY="skyEth", FINAL_MS=12000;
  const SKY_THEMES=[
    {n:"MOONRISE",s:["sky0","sky1","sky2","sky3","sky4"]},
    {n:"THE PAD",s:["skyPad","sky1","sky2","sky3","sky4"]},
    {n:"CLOUD DECK",s:["sky1","sky2","sky3","sky4"]},
    {n:"BLUE HOUR",s:["sky1","sky2","sky3","sky4"],g:"70,110,255,.32"},
    {n:"ORANGE ORBIT",s:["sky1","sky2","skyBtc","sky4"],g:"255,140,50,.28"},
    {n:"PINK DUSK",s:["sky0","sky1","sky2","sky3","sky4"],g:"240,48,127,.38"},
    {n:"DEEP SPACE",s:["sky2","sky3","sky4"],g:"120,80,255,.22"}];
  const THEMES=SKY_THEMES.filter(t=>t.s.every(k=>A[k]));
  let THEME=THEMES[0], SKY_ORDER=THEME.s;
  function pickSky(seed){
    const N=THEMES.length; let last=null; try{ last=localStorage.getItem("duel.sky"); }catch(e){}
    const li=THEMES.findIndex(t=>t.n===last);
    let i=seed!=null?((Math.imul(Math.floor(seed/1000)|0,2654435761)>>>0)%N):Math.floor(Math.random()*N);
    if(i===li&&N>1) i=seed!=null?(i+1)%N:(li+1+Math.floor(Math.random()*(N-1)))%N;
    THEME=THEMES[i]; SKY_ORDER=THEME.s; try{ localStorage.setItem("duel.sky",THEME.n); }catch(e){}
  }
  function resize(){
    DPR=Math.min(2,devicePixelRatio||1); SW=sky.clientWidth; SH=sky.clientHeight; sky.width=Math.round(SW*DPR); sky.height=Math.round(SH*DPR);
    stars=Array.from({length:70},()=>({x:Math.random()*SW,y:Math.random()*SH,z:rnd(.25,1)}));
    resizeK();
  }
  on(window,"resize",resize);
  function resizeK(){ if(SW) layout(); }
  function RH(){ return LAY?LAY.h:Math.round(Math.max(72,Math.min(SW>=900?150:116,SH*.17))); }   // current rocket size (shrinks as the gap opens)
  function lane0(pl){ if(SW>=900) return SW/2+(pl.me?-1:1)*Math.max(60,(LAY?LAY.rh0:RH())*.5);   // desktop: as close as on a phone (about one rocket height apart)
    return pl.me?SW*.30:SW*.70; }
  const SYM=()=>LAY?LAY.barTop-LAY.under:300;
  function myOffRange(){ if(!LAY||LAY.sep==null) return [-20,20]; const lead=LAY.lead>=0.01; return lead?[-20,LAY.sep]:[-Math.min(20,LAY.sep*.3),SYM()]; }   // fly up/down anywhere in the sky: drop to their level to gloat, the $ tag still shows the real gap
  function lane(pl){ return lane0(pl)+(pl.sxo||0); }
  /* steering: drag the sky (phone) or hold A/D (desktop). Tricks: swipe up = spin, double-tap = flip, Q/E on desktop. */
  function steerTo(pl,off){ const b=lane0(pl); pl.sxt=Math.max(34-b,Math.min(SW-34-b,off)); }
  const TRICKS={spin:{dur:.7,txt:"SPIN!",c:"#8FE3FF"},flip:{dur:.85,txt:"FLIP!",c:"#F2C14E"}};
  function trick(pl,kind){
    if(!G||!G.started||G.over||!pl||(G.solo&&!pl.me)) return; if(pl.trick&&pl.trick.t<pl.trick.dur) return;
    pl.trick={kind,t:0,dur:TRICKS[kind].dur};
    FX.pops.push({txt:TRICKS[kind].txt,c:TRICKS[kind].c,x:lane(pl),y:pl.y-RH()*.75,age:0,max:1.1,size:pl.me?28:22});
    FX.rings.push({x:lane(pl),y:pl.y,r:20,vr:420,life:.5,max:.5,w:5,col:kind==="spin"?"143,227,255":"242,193,78"});
    for(let i=0;i<24;i++){const a=rnd(0,Math.PI*2),sp=rnd(120,320); part({x:lane(pl),y:pl.y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.4,.8),size:rnd(2,3.5),col:kind==="spin"?"143,227,255":"255,214,120"});}
    if(pl.me){ sfx("trick"); buzz(12); if(M&&M.net) host.trick(kind); } else feed(pl,"t",`${pl.name} did a <b>${kind}</b> on you`);
  }
  let drag=null, lastTap=0;
  function skyDown(e){ if(!G||!G.started||G.over) return; drag={x:e.clientX,y:e.clientY,t:performance.now(),off:G.me.sxt||0,offY:G.me.syt||0,moved:false}; try{sky.setPointerCapture(e.pointerId);}catch(_){} }
  function skyMove(e){ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(Math.abs(dx)>8) drag.moved=true; steerTo(G.me,drag.off+dx*1.15); if(performance.now()-drag.t>200) G.me.syt=Math.max(-SYM(),Math.min(SYM(),(drag.offY||0)+dy*.9)); }
  function skyUp(e){ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y, dt=performance.now()-drag.t, now=performance.now();
    if(dy<-55&&Math.abs(dy)>Math.abs(dx)*1.3&&dt<450) trick(G.me,"spin");
    else if(Math.abs(dx)<10&&Math.abs(dy)<10&&dt<250){ if(now-lastTap<320){trick(G.me,"flip"); lastTap=0;} else lastTap=now; }
    drag=null; }

  /* layout, measured once a frame against the sky canvas (rects, not offsetTop):
   * the rockets fly between the chart (or, on phones, the feed under it) and the trade bar.
   * top/bot are the highest and lowest a rocket's centre may sit: top leaves room for the LEADING + name tags above
   * the leader, bot lets the trailer's nose sit just above the trade bar. Rocket size shrinks to fit short screens,
   * so there is always real room for the gap between the two. */
  let LAY=null;
  function layout(){
    const c=$("sky").getBoundingClientRect(), ch=root.querySelector(".chart").getBoundingClientRect(), bt=root.querySelector(".bottom").getBoundingClientRect();
    const cb=$("chatB").getBoundingClientRect(), under=(SW>=900||host.embed?ch.bottom-c.top:cb.bottom-c.top)+8, barTop=bt.top-c.top-30;   // the trailer keeps a clear gap above the trade bar; phones: clear the sound/chat buttons too
    const rh0=Math.round(Math.max(56,Math.min(SW>=900?150:116,SH*.17,(barTop-under)*.42)));   // rocket size when level
    LAY=Object.assign(LAY||{h:rh0},{under,barTop,rh0});
  }
  function band(){ if(!LAY) layout(); return [LAY.under,LAY.barTop]; }
  const alt=pl=>profitOf(pl);                       // $ of altitude
  const worldY=pl=>-alt(pl)*K;                       // world px (springs + kicks live here), up is negative
  function part(o){ if(FX.parts.length>280) return; const p=Object.assign({life:1,size:4,g:0,drag:1.5,add:true},o); p.max=p.life; FX.parts.push(p); }
  function popAt(pl,txt,c){ FX.pops.push({txt,c,x:lane(pl),y:pl.y-RH()*.7,age:0,max:1.4,size:pl.me?30:22}); }
  function fxTrade(pl,side,stake){
    const k=Math.min(1,stake/20), m=pl.me?1:.6;
    pl.flame=Math.min(2.2,pl.flame+(.7+k)*m); pl.kick-= (220+k*260)*m; pl.sq=-.22*m; pl.vr+=(Math.random()-.5)*.8*m;
    const x=lane(pl), y=pl.y+RH()*.45, c1=side>0?"255,214,120":"255,143,189", c2=side>0?"255,160,70":"240,48,127";
    for(let i=0;i<Math.round((24+k*46)*m);i++){const a=Math.PI/2+rnd(-.6,.6), sp=rnd(220,620); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.35,.85),size:rnd(2,4.8),col:Math.random()<.5?c1:c2});}
    for(let i=0;i<Math.round(10*m);i++) part({x:x+rnd(-10,10),y:y+rnd(0,20),vx:rnd(-90,90),vy:rnd(60,200),life:rnd(.8,1.5),size:rnd(14,26),col:"235,232,245",kind:"smoke",add:false});
    FX.rings.push({x,y:y+6,r:8,vr:380+k*320,life:.45,max:.45,w:6+k*4,col:c1});
    if(pl.me){ FX.flash=Math.max(FX.flash,.12+k*.15); FX.flashC=side>0?"255,206,100":"240,48,127"; sfx(side>0?(k>=1?"boostBig":"boost"):"dump"); buzz(side>0?18:[10,20,10]); }
    else rivalSfx(side>0?(k>=1?"boostBig":"boost"):"dump",.75,(lane(pl)/SW)*2-1);
  }
  function fxBomb(pl){
    const x=lane(pl), y=pl.y;
    part({x,y,vx:0,vy:0,life:.5,size:150,kind:"ball",drag:0});
    for(let i=0;i<90;i++){const a=rnd(0,Math.PI*2), sp=rnd(140,700); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.4,1),size:rnd(2.5,6),col:Math.random()<.4?"255,240,200":"255,120,60"});}
    for(let i=0;i<16;i++){const a=rnd(0,Math.PI*2), sp=rnd(60,240); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(1,1.8),size:rnd(18,40),col:"70,62,80",kind:"smoke",add:false});}
    FX.rings.push({x,y,r:16,vr:900,life:.55,max:.55,w:14,col:"255,240,220"}); FX.rings.push({x,y,r:6,vr:520,life:.7,max:.7,w:6,col:"240,48,127"});
    FX.pops.push({txt:"NUKE",c:"#F0307F",x,y:y-80,age:0,max:1.6,size:34});
    nukeClip(x,y);
    if(pl.me){ FX.red=1; FX.warn=0; if(!reduce){FX.shake=26; FX.flash=.35; FX.flashC="255,245,235";} }
    pl.kick+=500; pl.sq=.25; pl.vr+=(Math.random()<.5?-1:1)*3;
  }
  function rr(x,y,w,h,r){sx.beginPath(); sx.roundRect?sx.roundRect(x,y,w,h,r):sx.rect(x,y,w,h);}
  const SPACE=new Set(["sky3","sky4"]);
  // where the journey is: f = position in the theme's layers (0 = ground), fin = 0..1 fade into the final sky
  function skyStage(pan){ const N=SKY_ORDER.length; if(!G||!G.started) return {f:0,fin:0};
    if(G.solo&&CLR&&CLR.goal!=null){ const u=Math.min(1.4,soloProg()); G.sp=G.sp==null?u:G.sp+(u-G.sp)*.05;
      const tp=Math.max(0,Math.min(1,G.t/G.len)), up=1-Math.pow(1-tp,1.6), j=Math.min(1,.55*up+.55*Math.min(1,G.sp));
      G.lift=Math.max(0,Math.min(1,G.t/SOLO_LIFT));
      return {f:Math.max(0,Math.min(N-1,1+j*(N-2))),fin:Math.max(0,Math.min(1,(G.sp-1)/.3)),solo:1}; }
    const run=Math.max(1,G.len-FINAL_MS), p=Math.max(0,Math.min(1,G.t/run));
    if(G.finalAt==null&&G.t>=run&&!G.over){ G.finalAt=G.t; toast("Final 12 seconds"); }   // latched: overtime stays on the moon
    const fin=G.finalAt!=null?Math.min(1,(G.t-G.finalAt)/1500):0;
    const nudge=Math.max(-.6,Math.min(.6,-(pan||0)/Math.max(1,SH)*.5));
    return {f:Math.max(0,Math.min(N-1,p*(N-1)+nudge)),fin}; }
  function skyDens(pan){ const {f,fin}=skyStage(pan), i0=Math.floor(f), t=f-i0, sp=k=>k&&SPACE.has(k)?1:0;
    return (1-.88*(sp(SKY_ORDER[i0])*(1-t)+sp(SKY_ORDER[Math.min(SKY_ORDER.length-1,i0+1)])*t))*(1-.85*fin); }   // clouds thin out toward space, all but gone at the moon
  // Climb (maker 2026-11-18: "think of a rocket rising ... the background needs to reflect that"): it's a launch. At GO the
  // pad plate falls out the bottom of the screen within SOLO_LIFT ms, then each sky plate slides down as it fades into the
  // next, so the whole run reads as rising. The journey runs on the clock and runs further as you near the goal.
  const SOLO_LIFT=3500;
  // the pad plate with its top third faded to clear, cached per screen size
  let padC=null; function padCut(){ const im=imgs[SKY_ORDER[0]]; if(!im||!im.complete||!im.width) return null;
    if(padC&&padC.k===SKY_ORDER[0]&&padC.w===SW&&padC.h===SH) return padC.c;
    const s=Math.max(SW/im.width,SH/im.height)*1.12, w=im.width*s, h=im.height*s, c=document.createElement("canvas"); c.width=Math.ceil(SW); c.height=Math.ceil(h);
    const x=c.getContext("2d"); x.drawImage(im,(SW-w)/2,0,w,h); x.globalCompositeOperation="destination-out";
    const g=x.createLinearGradient(0,0,0,h*.45); g.addColorStop(0,"rgba(0,0,0,1)"); g.addColorStop(.35,"rgba(0,0,0,.85)"); g.addColorStop(1,"rgba(0,0,0,0)"); x.fillStyle=g; x.fillRect(0,0,c.width,h*.45);
    padC={k:SKY_ORDER[0],w:SW,h:SH,c}; return c; }
  function drawSoloBackdrop(st){ const f=st.f, i0=Math.floor(f), t=f-i0;
    const plate=(k,a,off)=>{ const im=imgs[k]; if(!im||!im.complete||a<=0) return; const s=Math.max(SW/im.width,SH/im.height)*1.6, w=im.width*s, h=im.height*s;
      const sl=(h-SH)/2, y=(SH-h)/2+Math.max(-sl,Math.min(sl,off)); sx.globalAlpha=a; sx.drawImage(im,(SW-w)/2,y,w,h); sx.globalAlpha=1; };
    sx.fillStyle="#121327"; sx.fillRect(0,0,SW,SH);
    const SL=SH*.3;   // a plate slides this far as it fades in and out
    plate(SKY_ORDER[i0],1,t*SL); if(t>0&&i0+1<SKY_ORDER.length) plate(SKY_ORDER[i0+1],t,(t-1)*SL);
    if(st.fin>0) plate(A[FINAL_SKY]?FINAL_SKY:"sky4",st.fin,0);
    const L=G.lift==null?0:G.lift; if(L<1){ const pc=padCut(); if(pc){ const e=L*L*(3-2*L), y=(SH-pc.height)/2+e*SH*1.25;
      sx.globalAlpha=1-L*.3; sx.drawImage(pc,0,y); sx.globalAlpha=1;
      // a fog bank rides the pad's top edge so the ground melts into the sky instead of a hard line (maker 2026-11-18)
      const fy=y+pc.height*.3, g=sx.createLinearGradient(0,fy-SH*.22,0,fy+SH*.22); g.addColorStop(0,"rgba(200,206,228,0)"); g.addColorStop(.5,`rgba(200,206,228,${.32*(1-L)})`); g.addColorStop(1,"rgba(200,206,228,0)");
      sx.fillStyle=g; sx.fillRect(0,fy-SH*.22,SW,SH*.44); } }   // the ground drops away under you
    sx.fillStyle="rgba(11,10,22,.28)"; sx.fillRect(0,0,SW,SH); }
  function drawBackdrop(camAlt,pan){
    const st=skyStage(pan); if(st.solo){ drawSoloBackdrop(st); return; } const f=st.f, i0=Math.floor(f), t=f-i0;
    const draw=(k,a)=>{const im=imgs[k]; if(!im||!im.complete||a<=0) return; const s=Math.max(SW/im.width,SH/im.height)*1.12;
      const sl=(im.height*s*1.18-SH)/2, par=Math.max(-sl,Math.min(sl,-(pan||0)*.05)); sx.globalAlpha=a; sx.drawImage(im,(SW-im.width*s*1.18)/2,(SH-im.height*s*1.18)/2+par,im.width*s*1.18,im.height*s*1.18); sx.globalAlpha=1;};
    sx.fillStyle="#121327"; sx.fillRect(0,0,SW,SH);
    draw(SKY_ORDER[i0],1); if(t>0&&i0+1<SKY_ORDER.length) draw(SKY_ORDER[i0+1],t);
    if(THEME.g&&st.fin<1){ sx.globalAlpha=1-st.fin; sx.globalCompositeOperation="overlay"; sx.fillStyle=`rgba(${THEME.g})`; sx.fillRect(0,0,SW,SH); sx.globalCompositeOperation="source-over"; sx.globalAlpha=1; }
    if(st.fin>0) draw(A[FINAL_SKY]?FINAL_SKY:"sky4",st.fin);   // the same final sky every race
    sx.fillStyle="rgba(11,10,22,.28)"; sx.fillRect(0,0,SW,SH);
  }
  function drawRuler(){
    // altitude marks in $, on the same scale as the gap between the rockets; START is the even line
    if(!LAY||LAY.pxPer==null) return; const pxPer=LAY.pxPer, top=LAY.under-10;
    let step=[1,2,5,10,25,50,100].find(v=>v*pxPer>44)||100;
    const pn=LAY.pan||0, lo=LAY.pmid+(LAY.mid-pn-SH)/pxPer, hi=LAY.pmid+(LAY.mid-pn-top)/pxPer;   // the marks in view, panned with free flight
    sx.font="700 11px "+GF+",sans-serif"; sx.textAlign="right"; sx.textBaseline="bottom";
    for(let v=Math.ceil(Math.min(lo,hi)/step)*step-step*40, n=0; n<200; v+=step, n++){
      const y=LAY.mid+(LAY.pmid-v)*pxPer-(LAY.pan||0); if(y>SH) continue; if(y<top) break;
      const even=v===0; sx.strokeStyle=even?"rgba(255,255,255,.45)":"rgba(255,255,255,.12)"; sx.lineWidth=even?1.5:1; sx.setLineDash(even?[6,5]:[3,7]);
      sx.beginPath(); sx.moveTo(0,y); sx.lineTo(SW,y); sx.stroke(); sx.setLineDash([]);
      sx.fillStyle=even?"rgba(242,243,247,.85)":v>0?"rgba(95,240,160,.7)":"rgba(255,143,189,.7)";
      sx.fillText(even?"START":(v>0?"+$":"\u2212$")+Math.abs(v),SW-12,y-3);
    }
  }
  function drawGap(){
    if(!G||!G.started) return; const a=G.me, b=G.bot, d=profitOf(a)-profitOf(b); if(Math.abs(d)<0.05) return;
    if(LAY&&(b.y<LAY.under||b.y>LAY.barTop+(LAY.hr||RH())*.6)) return;   // rival out of view (free flight): the edge pill carries the gap
    const top=Math.min(a.y,b.y), bot=Math.max(a.y,b.y); if(bot-top<30) return;
    const x=(lane(a)+lane(b))/2, col=d>0?"95,240,160":"255,143,189";
    sx.strokeStyle=`rgba(${col},.55)`; sx.lineWidth=2; sx.setLineDash([4,5]);
    sx.beginPath(); sx.moveTo(x,top); sx.lineTo(x,bot); sx.stroke(); sx.setLineDash([]);
    sx.beginPath(); sx.moveTo(x-6,top); sx.lineTo(x+6,top); sx.moveTo(x-6,bot); sx.lineTo(x+6,bot); sx.stroke();
    const t=(d>0?"+":"\u2212")+"$"+Math.abs(d).toFixed(2); sx.font="800 16px "+GF+",sans-serif";
    const w=sx.measureText(t).width+12, my=(top+bot)/2; sx.fillStyle=`rgba(${col},.95)`; rr(x-w/2,my-11,w,22,8); sx.fill();
    sx.fillStyle="#121327"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(t,x,my+1);
  }
  // the trail's particles, shed from the nozzle and left behind as the sky streams past (screen space, additive)
  function bitsTick(pl,x,y,h,w,thrust,now){ const bi=pl.tf.bits; if(!ready(bi)) return; const b=pl.bits||(pl.bits=[]), dt=Math.min(.05,(now-(pl.bitT||now))/1000); pl.bitT=now;
    pl.bitAcc=(pl.bitAcc||0)+dt*(6+8*Math.min(2,thrust)); const nz=pl.hull?pl.hull.nz:[[.5,.97,1]];
    while(pl.bitAcc>=1&&b.length<40){ pl.bitAcc--; const n=nz[Math.floor(Math.random()*nz.length)];
      b.push({x:x+(n[0]-.5)*w+rnd(-3,3),y:y+h*.5+rnd(4,h*.35),vx:rnd(-14,14),vy:rnd(70,150),r:rnd(0,6.28),vr:rnd(-2,2),s:h*rnd(.18,.3)*n[2],f:pl.tf.seed!=null&&Math.random()<.5?pl.tf.seed%3:Math.floor(Math.random()*3),t:0,life:rnd(.6,1.1)}); }
    if(pl.bitAcc>1) pl.bitAcc=1;
    const fw=bi.naturalWidth/3, fh=bi.naturalHeight; sx.globalCompositeOperation="lighter";
    for(let i=b.length-1;i>=0;i--){ const p=b[i]; p.t+=dt; if(p.t>=p.life){ b.splice(i,1); continue; } p.x+=p.vx*dt; p.y+=p.vy*dt; p.r+=p.vr*dt;
      const k=1-p.t/p.life; sx.globalAlpha=Math.min(1,k*1.4); sx.save(); sx.translate(p.x,p.y); sx.rotate(p.r); const sz=p.s*(.6+.4*k); sx.drawImage(bi,p.f*fw,0,fw,fh,-sz/2,-sz/2,sz,sz); sx.restore(); }
    sx.globalAlpha=1; sx.globalCompositeOperation="source-over"; }
  // flown away from the race: a pill at the edge points to the rival, with the real gap
  function offPointer(){ const b=G.bot, hh=LAY.hr||RH(); const up=b.y<LAY.under-hh*.3, dn=b.y>LAY.barTop+hh*.6; if(!up&&!dn) return;
    const d=profitOf(G.bot)-profitOf(G.me), t=`${up?"\u25b2":"\u25bc"} ${G.bot.name} ${usd(profitOf(G.bot),true)}`;
    sx.font="800 13px "+GF+",sans-serif"; const w=sx.measureText(t).width+16, x=Math.max(w/2+8,Math.min(SW-w/2-8,lane(b))), y=up?LAY.under+6:LAY.barTop-2;
    sx.fillStyle="rgba(240,48,127,.92)"; rr(x-w/2,y,w,22,8); sx.fill(); sx.fillStyle="#fff"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(t,x,y+11.5); }
  function drawRocket(pl,now,leader){
    if(!pl.me&&LAY&&(pl.y<LAY.under-(LAY.hr||RH())*.3||pl.y>LAY.barTop+(LAY.hr||RH())*.6)) return;   // flown out of view: the edge pill shows them
    let x=lane(pl)+pl.dx, y=pl.y, img=imgs.rocket, h=pl.me?RH():(LAY&&LAY.hr||RH()*.9), w=pl.hull?h*pl.hull.a:h*221/609;
    const lean=Math.max(-.22,Math.min(.22,pl.rot));
    // flame grows while climbing, sputters while falling
    const thrust=Math.max(.25,Math.min(2.4,.6+pl.flame*.6-pl.wvy*.004)), fl=thrust+Math.sin(now/40+(pl.me?0:2))*.08;
    const c=pl.me||pl.tf?pl.flameC:"255,95,170";   // team colours: gold = you, pink = rival (a real rival's trail keeps its gold core)
    if(pl.tf&&!reduce) bitsTick(pl,x,y,h,w,thrust,now);
    const tr=pl.trick&&pl.trick.t<pl.trick.dur?pl.trick:null, tp=tr?tr.t/tr.dur:0, ease=tp<.5?2*tp*tp:1-Math.pow(-2*tp+2,2)/2;
    sx.save(); sx.translate(x,y); sx.rotate(lean+Math.max(-.35,Math.min(.35,pl.steerLean||0))+(tr&&tr.kind==="flip"?ease*Math.PI*2:0));
    if(tr&&tr.kind==="spin"){ const c=Math.cos(ease*Math.PI*4); sx.scale(Math.abs(c)<.08?.08*Math.sign(c||1):c,1); }
    drawShip(sx,pl.hull,img,h,fl,c,pl.sq,pl.tf,now);   // flames scale with the rocket
    sx.restore();
    if(pl.me&&G.flourish!=null&&pl.fl){ const ft=(now-G.flourish)/75, fi=artImg(pl.fl);   // your win: confetti + starburst over the rocket
      if(ft>=8) G.flourish=null; else if(ready(fi)){ const fw=fi.naturalWidth/8, s2=h*2.4; sx.globalCompositeOperation="lighter"; sx.drawImage(fi,Math.floor(ft)*fw,0,fw,fi.naturalHeight,x-s2/2,y-s2/2,s2,s2); sx.globalCompositeOperation="source-over"; } }
    // tags sit beside the rocket (on the side away from the rival), so the height between chart and bar is all race
    const other=pl.me?(G.bot||pl):G.me, side=lane(pl)<=lane(other)?-1:1;
    const pr=profitOf(pl), txt=(pl.me?"YOU ":pl.name+" ")+usd(pr,true);
    sx.font=`800 ${pl.me?15:13}px ${GF},sans-serif`; const tw=sx.measureText(txt).width+14;
    const t2=pl.pos?`${pl.pos.side>0?"BOOST \u25b2":"DUMP \u25bc"} ${LEV}\u00d7`:"";
    // a collected name-tag plate replaces the dark pill (the middle of each plate is empty; prestige plates have an emblem on the left)
    const tg=pl.tag&&ready(pl.tag.img)?pl.tag:null, inner=tg&&tg.pr?.6:.72, pw=tg?Math.max((pl.me?30:26)*600/140,tw/inner):0, ph=tg?pw*140/600:22;
    const bw=Math.max(tw,pw,leader?70:0,pl.pos?90:0); let cx=x+side*(w/2+14+bw/2); const cramped=cx-bw/2<6||cx+bw/2>SW-6; cx=Math.max(bw/2+6,Math.min(SW-bw/2-6,cramped?x:cx));
    const trk=pl.trak!=null?`FLIGHTTRAK ${pl.trak}`:"";
    const rows=(leader?1:0)+1+(pl.pos?1:0), blockH=(leader?20:0)+ph+(pl.pos?20:0)+(trk?18:0); let ty=cramped?y-h/2-blockH-4:y-blockH/2;   // no room beside it: the tag rides above the nose
    if(leader){ sx.font="800 12px "+GF+",sans-serif"; const lw=sx.measureText("LEADING").width+12; sx.fillStyle="#F2C14E"; rr(cx-lw/2,ty,lw,17,6); sx.fill(); sx.fillStyle="#121327"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText("LEADING",cx,ty+9); ty+=20; }
    sx.font=`800 ${pl.me?15:13}px ${GF},sans-serif`;
    let tx=cx; if(tg){ sx.drawImage(tg.img,cx-pw/2,ty,pw,ph); if(tg.pr) tx=cx+pw*.13; } else { sx.fillStyle="rgba(11,10,22,.86)"; rr(cx-tw/2,ty,tw,22,7); sx.fill(); }
    sx.fillStyle=pr>0?"#5FF0A0":pr<0?"#FF8FBD":"#F2F3F7"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(txt,tx,ty+ph/2+.5); ty+=ph+3;
    if(trk){ sx.font="800 11px "+GF+",sans-serif"; const kw=sx.measureText(trk).width+12; sx.fillStyle="rgba(11,10,22,.86)"; rr(cx-kw/2,ty,kw,15,5); sx.fill(); sx.fillStyle="#F2C14E"; sx.fillText(trk,cx,ty+8); ty+=18; sx.font=`800 ${pl.me?15:13}px ${GF},sans-serif`; }
    if(pl.pos){ sx.font="700 12px "+GF+",sans-serif"; const w2=sx.measureText(t2).width+12;
      sx.fillStyle=pl.pos.side>0?"rgba(242,193,78,.92)":"rgba(240,48,127,.92)"; rr(cx-w2/2,ty,w2,17,6); sx.fill(); sx.fillStyle=pl.pos.side>0?"#121327":"#fff"; sx.fillText(t2,cx,ty+9); }
    if(pl.say&&now<pl.say.until){ const a=Math.min(1,(pl.say.until-now)/300); sx.globalAlpha=a; sx.font="700 15px "+GU+",system-ui,sans-serif"; const sw=Math.min(220,sx.measureText(pl.say.txt).width+20), by=y-blockH/2-8;
      const bx=Math.max(sw/2+6,Math.min(SW-sw/2-6,cx)); sx.fillStyle=pl.me?"#F2C14E":"#F0307F"; rr(bx-sw/2,by-26,sw,28,12); sx.fill();
      sx.beginPath(); sx.moveTo(bx-6,by+1); sx.lineTo(bx+6,by+1); sx.lineTo(bx,by+8); sx.fill();
      sx.fillStyle=pl.me?"#121327":"#fff"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(pl.say.txt,bx,by-12,sw-14); sx.globalAlpha=1; }
  }
  function drawSky(dt,now){
    if(!SW) resize();
    layout();
    sx.setTransform(DPR,0,0,DPR,0,0);
    const sh=FX.shake; FX.shake=Math.max(0,FX.shake-dt*60);
    let camDy=0;
    if(G){
      for(const pl of PL()){ if(pl.wy==null){pl.wy=0;pl.wvy=0;pl.kick=0;pl.dx=0;pl.rot=0;pl.vr=0;} }
      // world positions: spring toward altitude, plus kicks from trades
      for(const pl of PL()){
        const tgt=worldY(pl); pl.wvy+=((tgt-pl.wy)*14-pl.wvy*5.5)*dt + pl.kick*dt*6; pl.kick*=Math.max(0,1-dt*6); pl.wy+=pl.wvy*dt;
        pl.rot+= (Math.max(-.2,Math.min(.2,-pl.wvy*.0006*(pl.me?1:-1))) - pl.rot)*Math.min(1,dt*4) + pl.vr*dt; pl.vr*=Math.max(0,1-dt*3);
        if(pl.me){ if(keys.l) steerTo(pl,(pl.sxt||0)-460*dt); if(keys.r) steerTo(pl,(pl.sxt||0)+460*dt);
          if(keys.u) pl.syt=Math.max(-SYM(),(pl.syt||0)-420*dt); if(keys.dn) pl.syt=Math.min(SYM(),(pl.syt||0)+420*dt);
          if(!keys.u&&!keys.dn&&!drag) pl.syt=(pl.syt||0)*Math.max(0,1-dt*.35); }   // drifts back slowly, so you can hold a spot
        else { // the bot drifts around and keeps out of your way
          if(!pl.wander||now>pl.wander){ pl.wander=now+rnd(900,2600); const b0=lane0(pl), mx=lane(G.me), r=Math.random();
            if(r<.2){ const d=rnd(100,140), sd=mx-d<50?1:mx+d>SW-50?-1:(Math.random()<.5?-1:1); steerTo(pl,mx+sd*d-b0); }          // fly over next to you, on the side with room
            else if(r<.9) steerTo(pl,rnd(60,SW-60)-b0);                                // roam the sky
            else steerTo(pl,(pl.sxt||0)+rnd(-60,60));                                    // drift
            if(Math.random()<.12&&G.started&&!G.over&&!G.solo&&!(M&&M.net)) trick(pl,Math.random()<.5?"spin":"flip"); }
          const gap=lane(pl)-lane(G.me); if(Math.abs(gap)<90){ const roomR=SW-lane(G.me), roomL=lane(G.me); const dir=(gap>=0?(roomR>110?1:-1):(roomL>110?-1:1)); steerTo(pl,(pl.sxt||0)+dir*320*dt); }
        }
        pl.syo=(pl.syo||0)+((pl.syt||0)-(pl.syo||0))*Math.min(1,dt*8);
        const so=pl.sxo||0, st=pl.sxt||0, sv=(st-so)*Math.min(1,dt*8); pl.sxo=so+sv; pl.steerLean=(pl.steerLean||0)+((sv/Math.max(dt,1e-3))*.0009-(pl.steerLean||0))*Math.min(1,dt*6);
        if(pl.trick&&pl.trick.t<pl.trick.dur) pl.trick.t+=dt;
        pl.dx=Math.sin(now/900+(pl.me?0:2.1))*6; pl.flame=Math.max(0,pl.flame-dt*1.5); pl.sq+=(0-pl.sq)*Math.min(1,dt*10);
      }
      // camera: follow the middle of the pair, zoom out if the gap won't fit
      const top=LAY.under, bot=LAY.barTop, avail=bot-top;
      const d=G.solo?0:(G.bot.wy-G.me.wy)/K, ad=Math.abs(d)*500/LEV;  // smoothed $ lead (kicks included), scaled so 50× opens the gap as much as 500× did
      // both rockets are the same size (the higher one is winning, always); a bigger lead opens the gap and pulls the camera
      // back a little (rockets shrink to ~55% at most, never ants): $1 ≈ 40% of the room, $2 ≈ 65%, $5 ≈ 96%
      const hT=LAY.rh0*(1-.45*Math.tanh(ad/4)); LAY.h+=(hT-LAY.h)*Math.min(1,dt*3); LAY.hr=LAY.h;
      const h=LAY.h, hr=h, sep=(avail-h)*Math.tanh(ad/2.5), mid=(top+bot)/2;
      LAY.pxPer=ad>.3?sep/ad:2*h; LAY.pmid=-(G.me.wy+(G.bot||G.me).wy)/2/K; LAY.mid=mid; LAY.sep=sep; LAY.lead=d;
      cam.z=h/LAY.rh0;
      const ct=(G.me.wy+(G.bot||G.me).wy)/2, prev=cam.y; cam.vy+=((ct-cam.y)*9-cam.vy*5)*dt; cam.y+=cam.vy*dt; camDy=cam.y-prev;
      const lim=pl=>{ const hh=pl.me?h:hr; return [top+Math.max(hh*.5,34), bot-hh*.5]; };   // 34 = half the tag block beside the rocket
      // place the pair around the middle of the room
      const yMe0=mid+(d>=0?-1:1)*sep/2, yRv0=mid+(d>=0?1:-1)*sep/2;   // + is down
      // flying up/down: the leader can drop all the way to the loser's level to gloat; the loser can only sink, never climb
      // to the leader (catch up by trading). A few px of wiggle either way so steering still feels alive.
      // free flight (maker 2026-11-16, like Royale): fly up or down as far as you like. Inside the room your rocket moves;
      // past its edge your rocket stays at the edge and the camera flies with you, so the rival, the ruler and the clouds
      // slide away. Your $ tag and the gap label always show the real PnL.
      // maker 2026-11-16 (after trying free flight): keep the two rockets close, with the gap ruler between them, so you
      // can see the lead and taunt. Up/down is the old range again (the leader can drop to the loser's level; the loser
      // can't climb past). The flying feel comes from the clouds and the sky journey, not from roaming apart.
      const [oLo,oHi]=myOffRange(); G.me.syt=Math.max(oLo,Math.min(oHi,G.me.syt||0)); G.me.syo=Math.max(oLo,Math.min(oHi,G.me.syo||0));
      for(const [pl,y0] of (G.bot?[[G.me,yMe0],[G.bot,yRv0]]:[[G.me,yMe0]])){ const [a,b]=lim(pl); pl.y=Math.max(a,Math.min(b,y0+(pl.syo||0))); }
      if(G.solo){ const [a,b]=lim(G.me); G.me.y=Math.max(a,Math.min(b,soloY())); }   // Climb: the sky zooms to the run (START, goal, NUKE)
      LAY.pan=0; LAY.dPan=0;
      if(G.solo&&G.me.sVy) camDy+=G.me.sVy*(CLR&&CLR.goal!=null?1:2.2);
    }
    sx.save(); if(sh) sx.translate(rnd(-sh,sh)*.5,rnd(-sh,sh)*.5);
    const pan=LAY&&G?LAY.pan||0:0, dPan=LAY&&G?LAY.dPan||0:0; if(LAY) LAY.dPan=0;
    const camAlt=-cam.y/K, viewAlt=camAlt-pan/Math.max(60,LAY&&LAY.pxPer||60); drawBackdrop(viewAlt,pan);
    const speed=G&&G.started&&!G.over?(G.solo?110+260*(1-(G.lift==null?1:G.lift)):34):12, cdy=-camDy*.7-dPan;
    FLY.step(sx,SW,SH,dt,cdy,skyDens(pan),[0,1],speed);
    // stars stream with the camera: climbing makes them rush down past you
    const base=G&&G.started?(G.solo?180:50):25, v=base*dt - camDy*1.4 - dPan*.5;
    sx.fillStyle="rgba(255,255,255,.75)";
    for(const s of stars){ s.y+=v*s.z; if(s.y>SH){s.y-=SH;s.x=Math.random()*SW;} if(s.y<0){s.y+=SH;s.x=Math.random()*SW;} sx.fillRect(s.x,s.y,1.3*s.z,Math.max(1.5,Math.min(26,Math.abs(v)*1.6))*s.z); }
    if(G){
      if(G.solo) soloLines(); else { drawRuler(); drawGap(); }
      const lead=G.bot&&Math.abs(profitOf(G.me)-profitOf(G.bot))>0.005?(profitOf(G.me)>profitOf(G.bot)?G.me:G.bot):null;
      for(const pl of (G.solo?[G.me]:[G.bot,G.me])){
        const climbing=pl.wvy<-20;
        if(Math.random()<(climbing?.9:.5)*(pl.tf?.35:1)) part({x:lane(pl)+pl.dx+rnd(-4,4),y:pl.y+(pl.me?RH():RH()*.82)*.55,vx:rnd(-20,20),vy:rnd(120,220)+Math.max(0,-pl.wvy*.3),life:rnd(.5,.9),size:rnd(8,15),col:pl.tf?pl.flameC:pl.me?"255,226,160":"255,170,210",kind:"smoke",add:false});
        drawRocket(pl,now,!G.solo&&lead===pl);
      }
      FLY.step(sx,SW,SH,dt,cdy,skyDens(pan)*.8,[2],speed);
      if(!G.solo) offPointer();
    }
    for(let i=FX.parts.length-1;i>=0;i--){const p=FX.parts[i]; p.life-=dt; if(p.life<=0){FX.parts.splice(i,1);continue;}
      p.vx*=1-p.drag*dt; p.vy=p.vy*(1-p.drag*dt)+p.g*dt; p.x+=p.vx*dt; p.y+=p.vy*dt - camDy*cam.z - dPan; const a=p.life/p.max;
      sx.save(); if(p.add) sx.globalCompositeOperation="lighter";
      if(p.kind==="ball"){const r=p.size*(1.2-a*.6); const g=sx.createRadialGradient(p.x,p.y,0,p.x,p.y,r); g.addColorStop(0,`rgba(255,250,230,${a})`); g.addColorStop(.4,`rgba(255,150,60,${a*.8})`); g.addColorStop(1,"rgba(240,48,127,0)"); sx.fillStyle=g; sx.beginPath(); sx.arc(p.x,p.y,r,0,7); sx.fill();}
      else if(p.kind==="smoke"){sx.fillStyle=`rgba(${p.col},${a*.22})`; sx.beginPath(); sx.arc(p.x,p.y,p.size*(1.6-a*.6),0,7); sx.fill();}
      else {sx.fillStyle=`rgba(${p.col},${a})`; sx.beginPath(); sx.arc(p.x,p.y,p.size*a,0,7); sx.fill();}
      sx.restore();}
    for(let i=FX.rings.length-1;i>=0;i--){const r=FX.rings[i]; r.life-=dt; if(r.life<=0){FX.rings.splice(i,1);continue;} r.r+=r.vr*dt; r.y-=camDy*cam.z+dPan; const a=r.life/r.max; sx.strokeStyle=`rgba(${r.col},${a})`; sx.lineWidth=r.w*a; sx.beginPath(); sx.arc(r.x,r.y,r.r,0,7); sx.stroke();}
    for(let i=FX.pops.length-1;i>=0;i--){const p=FX.pops[i]; p.age+=dt; if(p.age>p.max){FX.pops.splice(i,1);continue;} const a=1-p.age/p.max, s=p.age<.12?p.age/.12:1;
      sx.font=`800 ${Math.round(p.size*(0.8+.2*s))}px ${GF},sans-serif`; sx.textAlign="center"; sx.textBaseline="middle"; sx.globalAlpha=a;
      sx.lineWidth=5; sx.strokeStyle="rgba(11,10,22,.85)"; sx.strokeText(p.txt,p.x,p.y-p.age*40); sx.fillStyle=p.c; sx.fillText(p.txt,p.x,p.y-p.age*40); sx.globalAlpha=1;}
    sx.restore();
    if(FX.flash>0){ sx.fillStyle=`rgba(${FX.flashC},${FX.flash*.35})`; sx.fillRect(0,0,SW,SH); FX.flash=Math.max(0,FX.flash-dt*2.2); }
    // red warning: your open trade has lost 40% of what sets off an NUKE; the edges glow and pulse faster as it gets closer
    let warn=0; if(G&&G.started&&!G.over&&G.me.pos){ const r=-pnlOf(G.me.pos,G.price)/(LIQ*G.me.pos.coll); if(r>.4) warn=Math.min(1,(r-.4)/.5); if(r>.85&&now>=(FX.warnAt||0)){ FX.warnAt=now+1200; sfx("nukeWarn"); } }
    FX.warn=(FX.warn||0)+(warn-(FX.warn||0))*Math.min(1,dt*6);
    const red=Math.max(FX.warn*(.75+.25*Math.sin(now/(reduce?400:(260-140*FX.warn)))), FX.red||0);
    const rv=$("redv"), ro=red>.01?red.toFixed(2):"0"; if(rv.style.opacity!==ro) rv.style.opacity=ro;   // the vignette sits over everything, chart and buttons too
    if(FX.red>0){ sx.fillStyle=`rgba(220,20,60,${FX.red*.45})`; sx.fillRect(0,0,SW,SH); FX.red=Math.max(0,FX.red-dt*.9); }
  }

  /* ---------- sound + haptics ---------- */
  let ac=null, muted=false;
  try{muted=localStorage.getItem("duel.mute")==="1";}catch(e){}
  // the engine hum plays in the iPhone app only (maker, 2026-11-16); its web view adds "DiscipleApp/" to the user agent
  const APP_FEEL=/DiscipleApp\//.test(navigator.userAgent)||!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
  function ensureAudio(){ if(!ac){ try{ac=new (window.AudioContext||window.webkitAudioContext)(); preloadSfx(); if(APP_FEEL) loadLoop("engine_loop");}catch(e){} } bedSync(); if(ac&&ac.state==="suspended") ac.resume(); }
  // recorded CC0 sounds (web/public/audio/sfx, see its README/SOURCES.csv). Each event picks one take at random.
  const SFX_BASE=A.sfxBase||"/audio/sfx/", BUF={};
  const SND={boost:["boost_small_01","boost_small_02","boost_small_03"],boostBig:["boost_big_01","boost_big_02"],dump:["bomb_fall_01","bomb_fall_02"],
    win:["cash_out"],lose:["explosion_small_01","explosion_small_02","explosion_small_03"],bomb:["nuke"],tick:["lever_notch_01","lever_notch_02","lever_notch_03"],
    go:["race_go"],trick:["trick_whoosh"],ot:["overtime_horn"],matchWin:["champion_01","champion_02"],matchLose:["duel_lose_sting"],nukeWarn:["nuke_warning_02"],
    count:["countdown_beep"],found:["match_found"],ready:["ready_lock"],lead:["lead_swap"],rateUp:["rating_up"],rateDn:["rating_down"],shutter:["share_shutter"],boom:["explosion_big_01","explosion_big_02"],crate:["crate_land_01","crate_land_02"],crateOpen:["crate_open"]};
  const VOL={dump:.7,tick:.6,nukeWarn:.55};
  function loadS(n){ if(!ac||n in BUF) return; BUF[n]=null; fetch(SFX_BASE+n+".m4a").then(r=>r.arrayBuffer()).then(a=>new Promise((ok,no)=>ac.decodeAudioData(a,ok,no))).then(b=>{BUF[n]=b;}).catch(()=>{BUF[n]=false;}); }
  function preloadSfx(){ for(const k in SND) SND[k].forEach(loadS); }
  // Settings › Sound › Sound effects (lib/game/settings, same localStorage key) sets the level of every sound here
  const SETK="disciple.game.settings.v1"; let sfxLvl=.7, bus=null, lastRival=0;
  function readLvl(){ try{ const o=JSON.parse(localStorage.getItem(SETK)||"null"); if(o&&o.sfx) sfxLvl=o.sfx.on===false?0:(typeof o.sfx.vol==="number"?o.sfx.vol:.7); }catch(e){} if(bus) bus.gain.value=sfxLvl*1.3; }
  readLvl(); const onStore=e=>{ if(e.key===SETK) readLvl(); }, onLvl=e=>{ if(e.detail&&typeof e.detail.sfx==="number"){ sfxLvl=e.detail.sfx; if(bus) bus.gain.value=sfxLvl*1.3; } };
  // the lobby gear (components/turbo/LobbySettings): Vibration, Reduce motion and the start size, from the same settings key
  let hapt=true;
  function readPrefs(){ let o=null; try{ o=JSON.parse(localStorage.getItem(SETK)||"null"); }catch(e){} o=o||{};
    hapt=o.haptics!==false; reduce=RM||o.reduceFx===true;
    if(PCTS.includes(o.turboSize)&&o.turboSize!==stake&&!(G&&G.started&&!G.over)){ stake=o.turboSize; if(G) paintSizes(); } }
  readPrefs(); on(window,"disciple:audio",readPrefs); on(window,"storage",e=>{ if(e.key===SETK) readPrefs(); });
  addEventListener("storage",onStore); addEventListener("disciple:audio",onLvl);
  function outBus(){ if(!bus&&ac){ bus=ac.createGain(); bus.gain.value=sfxLvl*1.3; bus.connect(ac.destination); } return bus; }
  // vol: 1 for you; a rival's boosts and blasts play quieter and panned to their side (pan -1 left … 1 right)
  function sfx(k,vol,pan){ if(!ac||muted||sfxLvl<=0) return; const list=SND[k]; if(!list) return; const n=list[Math.floor(Math.random()*list.length)], b=BUF[n]; if(!b){ loadS(n); return; }
    try{ const src=ac.createBufferSource(), g=ac.createGain(); src.buffer=b; g.gain.value=(VOL[k]||1)*(vol==null?1:vol); src.connect(g);
      if(pan&&ac.createStereoPanner){ const pn=ac.createStereoPanner(); pn.pan.value=Math.max(-1,Math.min(1,pan)); g.connect(pn); pn.connect(outBus()); } else g.connect(outBus()); src.start(); }catch(e){} }
  // rivals: at most one sound every 0.2 s, so a busy sky doesn't drown out your own
  function rivalSfx(k,vol,pan){ const t=performance.now(); if(t-lastRival<200) return; lastRival=t; sfx(k,vol,pan); }
  // ambience beds (public/audio/amb): mission control in the lobby, wind in the race, tension in overtime
  const BEDS={amb_mission_control:57,amb_wind_high:58,amb_tension:57}; let bedWant=null, bedOn=null;
  function bed(n){ bedWant=n; bedSync(); }
  function bedSync(){ if(!ac||(bedOn&&bedOn.n)===bedWant) return; const old=bedOn; bedOn=null;
    if(old){ try{ old.g.gain.setTargetAtTime(0,ac.currentTime,.6); setTimeout(()=>{ try{old.s.stop();}catch(e){} },3000); }catch(e){} }
    const n=bedWant; if(!n||muted) return; const key="bed:"+n;
    const go=b=>{ if(bedWant!==n||(bedOn&&bedOn.n===n)) return; try{ const src=ac.createBufferSource(), g=ac.createGain(); src.buffer=b; src.loop=true; src.loopStart=0; src.loopEnd=Math.min(BEDS[n],b.duration); g.gain.value=0; src.connect(g); g.connect(outBus()); src.start(); g.gain.setTargetAtTime(.9,ac.currentTime,.7); bedOn={n,s:src,g}; }catch(e){} };
    if(BUF[key]) return go(BUF[key]); if(key in BUF) return; BUF[key]=null;
    fetch(SFX_BASE.replace(/sfx\/$/,"amb/")+n+".m4a").then(r=>r.arrayBuffer()).then(a=>new Promise((ok,no)=>ac.decodeAudioData(a,ok,no))).then(b=>{ BUF[key]=b; go(b); }).catch(()=>{ BUF[key]=false; }); }
  // engine hum: a gapless loop under everything while you fly, louder and higher while the flame is lit
  let hum=null, humV=-1, humR=-1;
  function loadLoop(n){ const key="loop:"+n; if(!ac||key in BUF) return; BUF[key]=null; fetch(SFX_BASE+"loops-wav/"+n+".wav").then(r=>r.arrayBuffer()).then(a=>new Promise((ok,no)=>ac.decodeAudioData(a,ok,no))).then(b=>{BUF[key]=b;}).catch(()=>{BUF[key]=false;}); }
  function humTick(on,boost){ if(!ac) return; if(!APP_FEEL) on=false;
    if(!on||muted||sfxLvl<=0){ if(hum){ const h=hum; hum=null; try{ h.g.gain.setTargetAtTime(0,ac.currentTime,.12); setTimeout(()=>{ try{h.s.stop();}catch(e){} },700); }catch(e){} } return; }
    const b=BUF["loop:engine_loop"]; if(!b){ loadLoop("engine_loop"); return; }
    if(!hum){ try{ const src=ac.createBufferSource(), g=ac.createGain(); src.buffer=b; src.loop=true; g.gain.value=0; src.connect(g); g.connect(outBus()); src.start(); hum={s:src,g}; humV=humR=-1; }catch(e){ return; } }
    const v=Math.round((.16+.2*boost)*50)/50, r=Math.round((.92+.3*boost)*50)/50;
    if(v!==humV){ humV=v; hum.g.gain.setTargetAtTime(v,ac.currentTime,.15); } if(r!==humR){ humR=r; hum.s.playbackRate.setTargetAtTime(r,ac.currentTime,.2); } }
  function buzz(p){ if(!hapt) return; try{ if(navigator.vibrate) navigator.vibrate(p); }catch(e){} }
  function setMute(m){ muted=m; if(m){ const o=bedOn; bedOn=null; if(o) try{o.s.stop();}catch(e){} } else bedSync(); try{ host.mute&&host.mute(m); }catch(e){} $("mWave").toggleAttribute("hidden",m); $("mX").toggleAttribute("hidden",!m); $("mute").setAttribute("aria-label",m?"Unmute sound":"Mute sound"); try{localStorage.setItem("duel.mute",m?"1":"0");}catch(e){} }
  $("mute").addEventListener("click",()=>{ensureAudio(); setMute(!muted);});
  root.addEventListener("pointerdown",()=>ensureAudio(),true);   // the ambience starts on the first tap anywhere, not only on a launch button
  // a clicked button keeps focus, and Space/Enter would press it again (mute would un-mute on your next BOOST)
  root.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest("button"); if(b&&e.detail>0) b.blur(); });

  /* ---------- flow ---------- */
  let launchIv=null;
  function start(){
    ensureAudio(); openChat(false); pickSky(M&&M.net?M.startAt:null); newGame(); resetReport(); show("launch"); $("feed").innerHTML="";
    $("aLab").textContent="";   // no "LAUNCH IN · SKY" label (maker 2026-11-18): the big count says it
    $("lKeys").innerHTML=(SW>=900?[["SPACE","boost"],["SHIFT","dump"],["ENTER","cash out"],["WASD","fly"],["Q E","tricks"],["T","chat"]]:[["TAP","boost or dump"],["PILL","cash out"],["DRAG","steer"]]).map(([k,v])=>`<span><kbd>${k}</kbd>${v}</span>`).join("");
    if(G.bot) $("botLab").innerHTML=`${esc(G.bot.name).toUpperCase()} \u00b7 <span id="botN">0</span>`;
    FX.parts.length=0; FX.pops.length=0; cam={y:0,vy:0,z:1}; if(LAY){LAY.pan=0;LAY.dPan=0;} ui();
    const c=$("count"), pc=$("preCount"); c.hidden=true; let shown=null;
    const bot=!!(M&&!M.net&&G.bot); $("lH").textContent=bot?"BOT MATCH":"BOTH READY"; $("lCancel").hidden=!bot;
    $("lSub").innerHTML=bot?`${esc(G.bot.name)} \u00b7 ${tierName(botKey)} \u00b7 ${money(curFuel())} fuel ${RK(false)}`:"";
    if(G.solo){ const pad=THEMES.find(t=>t.n==="THE PAD")||THEMES.find(t=>t.n==="MOONRISE"); if(pad){ THEME=pad; SKY_ORDER=pad.s; } climbLaunch(); }
    clearInterval(launchIv); const iv=launchIv=setInterval(()=>{ if(dead){clearInterval(iv);return;} const left=G.startAt-now_(); const n=Math.ceil(left/1000);
      if(left>0){ if(n!==shown){ shown=n; pc.textContent=n; pc.style.animation="none"; void pc.offsetWidth; pc.style.animation=""; if(n<=3) sfx("count"); } return; }
      if(!priceReady()){ if(shown!=="wait"){ shown="wait"; priceWaitUi(true); }
        if(!(M&&M.net)&&-left>PRICE_WAIT_MS) noPrice();   // online duels: the server's clock runs the match
        return; }
      if(shown==="wait") priceWaitUi(false);
      clearInterval(iv); const pre=$("pre"); pre.classList.add("out"); setTimeout(()=>{ if(pre.classList.contains("out")) pre.hidden=true; },380);
      c.hidden=false; c.textContent="GO"; sfx("go"); buzz(30); G.started=true; track("duel_start"); music(true); if(coachStep()!=="done") coach(coachStep()==="out"?"out":"boost"); setTimeout(()=>c.hidden=true,450);
      if(!G.solo&&!(M&&M.net)&&Math.random()<.6) botSay(pick(["glhf","let's go","you're going down","\ud83e\udee1"]),1500);
      if(G.solo){ let seen=false; try{ seen=localStorage.getItem("climb.keysTip")==="1"; localStorage.setItem("climb.keysTip","1"); }catch(e){}   // first run only (copy rule)
        if(!seen) toast(SW>=900?"Space boost \u00b7 Shift dump \u00b7 Enter cash out":"Tap boost or dump \u00b7 tap the pill to cash out"); } else toast(SW>=900?"WASD to fly \u00b7 Space boost \u00b7 Shift dump \u00b7 Enter cash out \u00b7 T chat \u00b7 Q spin \u00b7 E flip":"Drag the sky to steer \u00b7 swipe up to spin \u00b7 double-tap to flip"); },100);
  }
  function end(){
    if(G.solo){ climbEnd(); return; }
    G.over=true; openChat(false); if(Math.random()<.8) setTimeout(()=>say(G.bot,pick(["gg","gg wp","rematch?"])),200);
    for(const pl of [G.me,G.bot]) if(pl.pos) close(pl);
    showResult(profitOf(G.me),profitOf(G.bot),null);
  }
  function endNet(res){
    if(G.over) return; G.over=true; openChat(false);
    const me=res.books[M.me], them=res.books[M.opp.pid];
    for(const [pl,b] of [[G.me,me],[G.bot,them]]){ if(pl.pos&&b&&!b.pos){ vClose(pl,pl.pos.side,(b.fuel-pl.fuel)-pl.pos.coll,res.price); } if(b) setBook(pl,b); }
    ui(); showResult(res.profit[M.me],res.profit[M.opp.pid],{delta:res.delta[M.me]||0,rating:res.rating[M.me],winner:res.winner,sp:res.season&&res.season[M.me],streak:res.streak&&res.streak[M.me]});
  }
  function showResult(pm,pb,net){ track("duel_finish");
    const win=pm>pb, tie=Math.abs(pm-pb)<0.005;
    const rec=Object.assign({w:0,l:0,rating:1200,streak:0},REC);
    const dr=net?net.delta:0;
    if(net&&net.rating) { rec.rating=net.rating; if((M.ranked||M.casual)&&!tie){ if(win){rec.w++;rec.streak++;} else {rec.l++;rec.streak=0;} } REC=rec; }
    if(M&&!M.net&&!tie&&!host.first) botAdjBy(win?.06:-.08);   // bots ease off after a loss, push after a win
    LAST={pm,pb,win:win&&!tie,tie,opp:G.bot.name,bot:!!(M&&!M.net),sat:G.me.up+G.me.dn===0,len:lenTxt()};
    { const x=host.climbing&&host.climbing(), a=$("rClimb"); a.hidden=!x;   // cross-link (maker 2026-11-16): a real rocket climbing right now
      if(x){ a.href=x.href; a.innerHTML=`<b>\u25b2 $${esc(x.sym)}</b><span>${esc(x.line)}</span><em>BOOST IT \u2192</em>`; } }
    { const el=$("rSeason"), sp=net&&net.sp, st=net&&net.streak!=null?net.streak:0, L=sp&&host.league?host.league(sp.league):null;   // season ladder (lib/duel/season)
      const fire=st>=3&&(st===3||st===5||(st>=10&&st%5===0));
      el.hidden=!sp&&!fire;
      el.innerHTML=(sp?`<span style="color:${L?L.color:"var(--gold)"}">${esc(L?L.name:sp.league)}</span><i>${sp.pts.toLocaleString("en-US")} SP</i><span class="${sp.delta>=0?"up":"dn"}">${sp.delta>=0?"+":"\u2212"}${Math.abs(sp.delta)}</span>`:"")
        +(fire?`<span class="fire">${st} WINS IN A ROW</span>`:""); }
    $("rSave").hidden=SIGNED||!!host.guest; $("rSave").textContent=win&&!tie?"SAVE YOUR WIN \u00b7 SIGN IN":RL?"SIGN IN TO GET RANKED":"SIGN IN TO SAVE YOUR RECORD";
    $("rH").textContent=tie?"DRAW":win?"YOU WIN":"YOU LOSE"; $("rH").style.color=tie?"var(--text)":win?"var(--gold)":"var(--pinkl)";
    const marg=Math.abs(pm-pb), card=document.querySelector(".res");
    card.classList.toggle("win",win&&!tie); $("result").classList.toggle("winbg",win&&!tie); $("rMarg").hidden=tie;
    $("rMargL").innerHTML=(win?"WON BY":"LOST BY")+(G.ot?'<span class="otc">OT</span>':""); $("rMargV").textContent="$"+marg.toFixed(2); $("rMargV").style.color=win?"":"var(--pinkl)";
    $("rSub").textContent="";   // flavour line cut (CLAUDE.md no-subtitle rule); WON BY carries it
    // the winner's card wears the crown; your red number goes quiet when you won anyway
    $("rMe").textContent=usd(pm,true); $("rMe").style.color=win&&pm<0?"var(--text)":pm>=0?"var(--green)":"var(--pinkl)";
    document.querySelector(".sc.me").classList.toggle("won",win&&!tie);
    document.querySelector(".sc.me small").innerHTML=win&&!tie?`you <span class="crown">WINNER</span>`:"you";
    $("rBot").textContent=usd(pb,true); $("rBot").style.color=pb>=0?"var(--green)":"var(--pinkl)"; $("rBotN").textContent=G.bot.name+(M&&!M.net?" \u00b7 bot":"");
    $("rMeS").textContent=`${G.me.up+G.me.dn} trades \u00b7 ${G.me.green} green \u00b7 $${G.me.fees.toFixed(2)} fees`;
    $("rBotS").textContent=`${G.bot.up+G.bot.dn} trades \u00b7 ${G.bot.green} green \u00b7 $${G.bot.fees.toFixed(2)} fees`;
    const all=[...G.me.moments,...G.bot.moments].sort((a,b)=>Math.abs(b.v)-Math.abs(a.v)).slice(0,3).sort((a,b)=>a.t-b.t);
    $("rMom").innerHTML=all.length?all.map(m=>`<div><span><span class="t">${m.t>LEN?"OT "+mmss(m.t-LEN):mmss(m.t)}</span>${m.txt}</span><b style="color:${m.v>=0?"var(--green)":"var(--pinkl)"}">${usd(m.v,true)}</b></div>`).join(""):`<div><span>No trades this time.</span></div>`;
    $("rRec").textContent=`${rec.w}-${rec.l}`; $("rRat").parentElement.hidden=!RL; $("rRat").parentElement.querySelector("small").textContent=net&&M.ranked?"Rating":"Rating (unranked)"; $("rRat").innerHTML=`${rec.rating.toLocaleString("en-US")} <span style="font-size:14px;color:${dr>=0?"var(--green)":"var(--pinkl)"}">${dr>=0?"+":"\u2212"}${Math.abs(dr)}</span>`; $("rStr").textContent=rec.streak;
    $("rAgain").textContent="REMATCH";
    // first win: the welcome crate drops in on this card (the host claims it, or asks for sign-in first; Grok playbook pick, maker 2026-11-16)
    $("rCrate").hidden=true; clearTimeout(crateT); coach(null);
    if(win&&!tie&&host.won) try{ host.won({bot:LAST.bot}); }catch(e){}
    if(win&&!tie&&!reduce) G.flourish=performance.now();
    sfx(win?"matchWin":"matchLose"); buzz(win?[20,40,20,40,60]:[80]); if(dr) setTimeout(()=>sfx(dr>0?"rateUp":"rateDn"),1400);
    if(win&&!tie&&!reduce){ const cols=["242,193,78","95,240,160","255,255,255","255,143,189","143,184,255"]; for(let k=0;k<3;k++) setTimeout(()=>{ for(let i=0;i<70;i++) part({x:SW*(.2+Math.random()*.6),y:SH*.25,vx:rnd(-260,260),vy:rnd(-520,-120),g:520,drag:.6,life:rnd(1.6,2.6),size:rnd(3,6),col:cols[i%cols.length],add:false}); },k*350); }
    resultClip(win&&!tie, ()=>{ $("result").hidden=false; $("rAgain").focus(); });
  }

  /* ---- lobby + matchmaking: every step goes through the host (server calls); the screens are the prototype's ---- */
  let REC={w:0,l:0,rating:1200,streak:0}, SIGNED=false, mode="ranked", vIv=0, waitT=0;
  function paintLobby(){ $("lRat").textContent=RL?REC.rating.toLocaleString("en-US"):`${REC.w}-${REC.l}`; $("lRec").textContent=RL?`${REC.w}-${REC.l} \u00b7 ${tierName(botKey)}`:tierName(botKey); $("vMe").textContent=RL?`${REC.rating.toLocaleString("en-US")} \u00b7 ${REC.w}-${REC.l}`:`${REC.w}-${REC.l}`;
    if(SIGNED||host.guest) $("goSub").innerHTML=RK(RL); else $("goSub").textContent=RL?"Sign in to duel a pilot near your rating.":"Sign in to duel a live pilot."; $("mkLink").textContent=(SIGNED||host.guest)?"CREATE DUEL LINK":"SIGN IN TO DUEL"; }
  /* the pre-match lobby is its own full screen (the board stays hidden and the chart doesn't draw until GO) */
  const PANES=["intro","search","invite","vs","launch"], STEP={intro:1,search:2,invite:2,vs:3,launch:4};
  // music only plays in a match (lib/game/turboMusic): on at GO, off back in the lobby
  function music(on){ try{ dispatchEvent(new CustomEvent("disciple:turbomusic",{detail:{on}})); }catch(e){} }
  function show(id){ for(const k of [...PANES,"result"]) $(k).hidden=k!==id; if(id!=="result") resultClipOff();   /* the win/lose clip sat on top of the next match (maker 2026-11-18: rematch "frozen") */ if(id!=="launch"&&id!=="result") music(false); bed(id==="launch"?"amb_wind_high":"amb_mission_control");
    const pre=PANES.includes(id); $("pre").hidden=!pre; $("pre").classList.remove("out"); if(pre) stage(id);
    if(id==="intro"){ paintLobby(); lerr(""); } }
  // Grok clips (public/anim, handoff 2026-11-17): C1 while searching, C3 before the result card, C6 on a NUKE
  const ANIM=A.animBase||"/anim/";
  function searchClip(on){ const v=$("aVid"), ar=$("arena"); if(!v) return;
    if(!on||reduce){ v.pause(); ar.classList.remove("vid"); return; }
    const k=ar.clientWidth>ar.clientHeight?"16x9":"9x16", src=ANIM+"C1-finding-"+k+".mp4";
    if(v.dataset.src!==src){ v.dataset.src=src; v.poster=ANIM+"C1-finding-"+k+"-poster.webp"; v.src=src; }
    const p=v.play(); ar.classList.add("vid"); if(p&&p.catch) p.catch(()=>ar.classList.remove("vid")); }
  function resultClip(win,go){ const v=$("rVid"), tall=innerHeight>innerWidth;
    if(reduce||!v){ go(); return; }
    let done=false; const fin=()=>{ if(done) return; done=true; clearTimeout(t); v.classList.add("dim"); go(); };
    const t=setTimeout(fin,3200);
    v.classList.remove("dim"); v.hidden=false; v.src=ANIM+"C3-duel-"+(win?"win":"lose")+"-"+(tall?"9x16":"16x9")+".mp4";
    v.onended=fin; v.onerror=()=>{ v.hidden=true; fin(); };
    const p=v.play(); if(p&&p.catch) p.catch(()=>{ v.hidden=true; fin(); }); }
  function resultClipOff(){ const v=$("rVid"); if(!v) return; v.pause(); v.hidden=true; v.removeAttribute("src"); v.load(); }
  function nukeClip(x,y){ const v=$("nVid"); if(reduce||!v) return; const r=sky.getBoundingClientRect(), ar=$("app").getBoundingClientRect();
    v.style.left=(r.left-ar.left+x)+"px"; v.style.top=(r.top-ar.top+y)+"px"; v.hidden=false;
    if(!v.dataset.src){ v.dataset.src="1"; v.src=ANIM+"C6-nuke.mp4"; } try{ v.currentTime=0; }catch(e){}
    v.onended=()=>{ v.hidden=true; }; const p=v.play(); if(p&&p.catch) p.catch(()=>{ v.hidden=true; }); }
  function stage(id){ $("arena").dataset.stage=id; const n=STEP[id]; searchClip(id==="search");
    document.querySelectorAll("#steps li").forEach(li=>{ const k=+li.dataset.s; li.classList.toggle("on",k===n); li.classList.toggle("done",k<n); if(k===n) li.setAttribute("aria-current","step"); else li.removeAttribute("aria-current"); });
    const live=id==="vs"||id==="launch"; $("vMeR").hidden=!live; $("vThemR").hidden=!live; $("preCount").hidden=id!=="launch"; $("aVs").hidden=id==="launch";
    $("aLab").textContent="";
    if(!live){ $("vAv").textContent="?";
      $("vName").textContent=id==="search"?"searching\u2026":id==="invite"?"your friend":"your rival";
      $("vThem").textContent=id==="search"&&RL?`near ${REC.rating.toLocaleString("en-US")}`:""; } }
  function lerr(t){ $("lErr").textContent=t||""; }
  function lenTxt(){ return "1 MIN"; }
  /* fuel tier names (maker 2026-11-18): the ids stay rookie / pro / shark */
  function tierName(k){ return ({rookie:"NORMIE",pro:"DEGEN",shark:"WHALE"})[k]||String(k).toUpperCase(); }
  document.querySelectorAll(".duel-root .tab").forEach(t=>t.addEventListener("click",()=>{ mode=t.dataset.tab; document.querySelectorAll(".duel-root .tab").forEach(x=>x.classList.toggle("on",x===t)); document.querySelectorAll(".duel-root [data-pane]").forEach(p=>p.hidden=p.dataset.pane!==mode); lerr(""); }));
  document.querySelectorAll(".duel-root [data-bot]").forEach(b=>{b.classList.toggle("on",b.dataset.bot===botKey); b.addEventListener("click",()=>{botKey=b.dataset.bot; document.querySelectorAll(".duel-root [data-bot]").forEach(x=>x.classList.toggle("on",x===b)); try{localStorage.setItem("duel.tier",botKey);}catch(e){} paintLobby();});});
  function online(casual){ ensureAudio(); if(!SIGNED){ host.signIn(); return; } mode="ranked"; show("search"); $("sH").textContent="FINDING A RIVAL"; $("sBot").hidden=true; $("sT").textContent="0:00";
    $("sSub").textContent=`${tierName(botKey)} \u00b7 ${lenTxt()}`+(casual?" \u00b7 UNRANKED":RL?` \u00b7 near ${REC.rating.toLocaleString("en-US")}`:""); host.quickMatch(botKey,LEN,!!casual); }
  $("go").addEventListener("click",()=>online(false));
  $("goC").addEventListener("click",()=>online(true));
  $("sCancel").addEventListener("click",()=>{ host.cancelSearch(); show("intro"); });
  $("sBot").addEventListener("click",()=>{ host.cancelSearch(); practice(); });
  $("lPractice").addEventListener("click",()=>{ ensureAudio(); practice(); });
  // the duel-only demo page (/duel, host.guest): guests play a bot or a friend's link; no ranked queue, no sign-in
  // the X timeline player (/duel?embed=1, about 480 x 480): a thin chart strip, no feed or size row, so the rockets get the frame
  if(host.embed) $("app").classList.add("embed");
  // lobby gear (maker 2026-11-18): next to the rating chip, opens the host's settings sheet (components/turbo/LobbySettings)
  if(host.settings){ const mc=root.querySelector(".pre-top .me-chip");
    if(mc){ const box=document.createElement("div"), g=document.createElement("button"); box.className="pre-r"; g.type="button"; g.className="pre-gear"; g.id="preGear"; g.setAttribute("aria-label","Settings");
      g.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.18 9.67 20.43 10.29 20.43 13.71 18.18 14.33 18.01 14.72 19.17 16.75 16.75 19.17 14.72 18.01 14.33 18.18 13.71 20.43 10.29 20.43 9.67 18.18 9.28 18.01 7.25 19.17 4.83 16.75 5.99 14.72 5.82 14.33 3.57 13.71 3.57 10.29 5.82 9.67 5.99 9.28 4.83 7.25 7.25 4.83 9.28 5.99 9.67 5.82 10.29 3.57 13.71 3.57 14.33 5.82 14.72 5.99 16.75 4.83 19.17 7.25 18.01 9.28z"/><circle cx="12" cy="12" r="2.75"/></svg>';
      mc.replaceWith(box); box.append(mc,g); g.addEventListener("click",()=>{ try{ host.settings(); }catch(e){} });
      if(!document.getElementById("duel-gear-css")){ const gs=document.createElement("style"); gs.id="duel-gear-css"; gs.textContent=GEAR_CSS; document.head.appendChild(gs); } } }
  // leave mid-match (maker 2026-11-18): an X at the top of the right-hand buttons, then a confirm. Climb closes your trade
  // right away; a duel's trades stay open until the clock ends (the server settles a leaver's book at the buzzer).
  { const app=$("app"); app.insertAdjacentHTML("beforeend",'<button class="mute quit" id="quitB" type="button" aria-label="Leave"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
      +'<div class="ov quitov" id="quitOv" hidden><div class="card qcard" role="dialog" aria-modal="true" aria-labelledby="qH"><h2 id="qH">LEAVE?</h2><p class="qwarn" id="qW" hidden></p>'
      +'<div class="rrow"><button class="sec" type="button" id="qStay">STAY</button><button class="go" type="button" id="qGo">LEAVE</button></div></div></div>');
    const live=()=>!!(G&&G.started&&!G.over);
    const qOpen=()=>{ if(!live()) return; const solo=!!G.solo, net=!!(M&&M.net), w=$("qW");
      $("qH").textContent=solo?"LEAVE THE RUN?":"LEAVE THE DUEL?";
      const txt=solo?(G.me.pos?"Your trade closes now.":""):(net?"Your trades stay open until the clock ends.":"");
      w.textContent=txt; w.hidden=!txt; $("quitOv").hidden=false; $("qStay").focus(); };
    const qShut=()=>{ $("quitOv").hidden=true; };
    const qLeave=()=>{ qShut(); if(!live()) return;
      if(G.solo){ if(G.me.pos) close(G.me); G.over=true; music(false); climbHome(); return; }   // climbHome ends the Lighter run (closes it there too)
      G.over=true; if(M&&M.net) void host.leave(); M=null; show("intro"); };
    $("quitB").addEventListener("click",qOpen); $("qStay").addEventListener("click",qShut); $("qGo").addEventListener("click",qLeave);
    $("quitOv").addEventListener("pointerdown",e=>{ if(e.target===e.currentTarget) qShut(); });
    on(window,"keydown",e=>{ if($("quitOv").hidden) return; e.stopPropagation(); if(e.key==="Escape") qShut(); },true);   // no boost / cash-out keys behind the confirm
    if(!document.getElementById("duel-quit-css")){ const qs=document.createElement("style"); qs.id="duel-quit-css"; qs.textContent=QUIT_CSS; document.head.appendChild(qs); } }
  if(host.guest){ $("go").hidden=true; const bk=root.querySelector(".pre-back"); if(bk) bk.style.visibility="hidden"; const mc=root.querySelector(".me-chip"); if(mc) mc.style.visibility="hidden"; const tb=document.querySelectorAll(".duel-root .tab"); if(tb[0]) tb[0].textContent="VS BOT"; if(tb[1]) tb[1].textContent="VS FRIEND";
    $("botSub").innerHTML=`Play money ${RK(false)}`; }
  $("mkLink").addEventListener("click",()=>{ ensureAudio(); if(!SIGNED&&!host.guest){ host.signIn(); return; } mode="friend"; lerr(""); host.createLink(botKey,LEN,CFUEL); });
  $("iCopy").addEventListener("click",()=>{ track("duel_share"); const t=$("iLink").dataset.url||""; try{navigator.clipboard.writeText(t); toast("Link copied");}catch(e){ toast(t); } });
  $("iX").addEventListener("click",()=>{ track("duel_share"); const t=encodeURIComponent(`1v1 me in a trading duel on DISCIPLE \u2694\ufe0f ${$("iCode").textContent}`), u=encodeURIComponent($("iLink").dataset.share||$("iLink").dataset.url||""); window.open(`https://x.com/intent/post?text=${t}&url=${u}`,"_blank","noopener"); });
  $("iCancel").addEventListener("click",()=>{ host.leave(); show("intro"); });
  $("joinF").addEventListener("submit",e=>{ e.preventDefault(); if(!SIGNED&&!host.guest){ host.signIn(); return; } const v=$("joinI").value.trim(); if(!v) return; ensureAudio(); mode="friend"; lerr(""); host.join(v); });
  function practice(){ M={net:false,ranked:false}; OFF=0; const bn=botCfg().name; opp={name:bn,bot:true}; openVs("BOT MATCH",{name:bn,bot:true},"unranked"); meReady(); }   // a bot is always ready: go straight to the countdown, which has a Cancel
  let opp=null;
  function openVs(tag,o,kind){ show("vs"); sfx("found"); opp=o; $("vTag").textContent=tag; $("vName").textContent=o.name; $("vAv").textContent=o.name.replace("@","").slice(0,2).toUpperCase();
    $("vMe").textContent=RL?`${REC.rating.toLocaleString("en-US")} \u00b7 ${REC.w}-${REC.l}`:`${REC.w}-${REC.l}`; $("vThem").textContent=o.bot?"bot":RL?`${(o.rating||1200).toLocaleString("en-US")} \u00b7 ${o.w||0}-${o.l||0}`:`${o.w||0}-${o.l||0}`;
    $("vSub").innerHTML=`${M&&M.fuel?"FRIEND":tierName(botKey)} \u00b7 ${money(curFuel())} fuel each \u00b7 ${lenTxt()} ${RK(kind==="ranked")}`;
    for(const id of ["vMeR","vThemR"]){ $(id).classList.toggle("on",!!(id==="vThemR"&&o.ready)); $(id).textContent=id==="vThemR"&&o.ready?"READY":"NOT READY"; }
    if(o.bot){ $("vThemR").classList.add("on"); $("vThemR").textContent="READY"; }   // a bot is always ready
    $("vReady").disabled=false; $("vReady").textContent="READY"; $("vAuto").hidden=!!o.bot;
    let n=10; $("vT").textContent=n; clearInterval(vIv); if(!o.bot) vIv=setInterval(()=>{ n--; $("vT").textContent=Math.max(0,n); if(n<=0){ clearInterval(vIv); meReady(); } },1000); }
  function meReady(){ clearInterval(vIv); $("vMeR").classList.add("on"); $("vMeR").textContent="READY"; $("vReady").disabled=true; $("vReady").textContent="WAITING\u2026"; sfx("ready");
    if(M&&!M.net){ waitForPrice(()=>{ if(!M||M.net) return; M.startAt=Date.now()+3500; M.endAt=M.startAt+LEN; start(); }); return; }
    host.ready(); }
  $("vReady").addEventListener("click",meReady);
  // live price gate: a tick in the last 10 s. Bot matches hold READY until one arrives, and give up after 15 s.
  const PRICE_FRESH_MS=10000, PRICE_WAIT_MS=15000; let pwIv=null;
  function priceReady(){ const h=host.history(); const k=h.length?h[h.length-1]:null; return !!k&&k.p>0&&Date.now()-k.ts<PRICE_FRESH_MS; }
  // no live price yet (maker 2026-11-18: Climb "froze on 3"): the big count pulses instead of sitting on a static 3, and
  // after PRICE_WAIT_MS the run is called off with an error, back to the levels (Climb) or the lobby (bot duel)
  const NO_PRICE="Can't reach the live BTC price right now. Try again in a moment.";
  function priceWaitUi(on){ const pc=$("preCount"); if(on){ pc.textContent="\u2022\u2022\u2022"; pc.classList.add("pwait"); } else pc.classList.remove("pwait"); }
  function noPrice(){ clearInterval(pwIv); clearInterval(launchIv); priceWaitUi(false); if(M&&M.solo){ climbHome(NO_PRICE); return; } M=null; show("intro"); lerr(NO_PRICE); }
  function waitForPrice(go){ clearInterval(pwIv); if(priceReady()){ go(); return; }
    const t0=Date.now(); $("vReady").textContent="WAITING FOR PRICE\u2026"; priceWaitUi(true);
    pwIv=setInterval(()=>{ if(dead||!M){ clearInterval(pwIv); priceWaitUi(false); return; }
      if(priceReady()){ clearInterval(pwIv); priceWaitUi(false); go(); return; }
      if(Date.now()-t0>PRICE_WAIT_MS) noPrice(); },250); }
  $("lCancel").addEventListener("click",()=>{ clearInterval(launchIv); if(!M||M.net) return; M=null; $("preCount").hidden=true; show("intro"); });
  $("vLeave").addEventListener("click",()=>{ clearInterval(vIv); if(M&&M.net) host.leave(); M=null; show("intro"); });
  $("rAgain").addEventListener("click",()=>{ track("duel_rematch"); if(M&&!M.net){ practice(); return; } $("rAgain").disabled=true; $("rAgain").textContent="WAITING\u2026"; host.rematch(); });
  $("rBack").addEventListener("click",()=>{ if(M&&M.net) host.toLobby(); M=null; show("intro"); });
  $("rShare").addEventListener("click",()=>{ void shareResult(); });
  $("rSave").addEventListener("click",()=>{ host.signIn(); });
  paintLobby();
  let CFUEL=100; try{ const v=+localStorage.getItem("duel.fuel"); if(okBud(v)) CFUEL=v; }catch(e){}
  function paintBudget(){ const pre=[5,100,1000].includes(CFUEL), i=$("budI");
    document.querySelectorAll(".duel-root [data-fuel]").forEach(b=>b.classList.toggle("on",+b.dataset.fuel===CFUEL));
    if(document.activeElement!==i) i.value=pre?"":String(CFUEL); i.parentNode.classList.toggle("on",!pre); }
  function setBudget(v){ CFUEL=v; try{localStorage.setItem("duel.fuel",String(v));}catch(e){} paintBudget(); }
  document.querySelectorAll(".duel-root [data-fuel]").forEach(b=>b.addEventListener("click",()=>{ lerr(""); setBudget(+b.dataset.fuel); }));
  $("budI").addEventListener("input",e=>{ const i=e.target; i.value=i.value.replace(/\D/g,""); const v=+i.value; if(okBud(v)){ lerr(""); setBudget(v); } });
  $("budI").addEventListener("blur",()=>{ const t=$("budI").value; if(t&&!okBud(+t)) lerr("Pick a budget from $5 to $10,000."); paintBudget(); });
  paintBudget();
  function setStake(v){stake=v; if(G) ui(); else paintSizes();}
  document.querySelectorAll(".size button").forEach(b=>b.addEventListener("click",()=>setStake(SIZES[+b.dataset.i])));
  $("quick").innerHTML=QUICK.map(q=>`<button type="button">${q}</button>`).join("");
  $("quick").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{ meSay(b.textContent); if(SW<900) openChat(false); }));
  function setChatMute(m){ chatMute=m; const b=$("cMute"); b.textContent=m?"CHAT MUTED \u00b7 UNMUTE":"MUTE CHAT"; b.classList.toggle("on",m); b.setAttribute("aria-pressed",m?"true":"false");
    if(m&&G&&G.bot){ G.bot.say=null; $("chatDot").hidden=true; } try{ localStorage.setItem("duel.chatMute",m?"1":"0"); }catch(e){} }
  setChatMute(chatMute);
  $("cMute").addEventListener("click",()=>setChatMute(!chatMute));
  on(window,"disciple:duelchat",e=>{ const m=!!(e.detail&&e.detail.mute); if(m!==chatMute) setChatMute(m); });   // Rival chat in the lobby gear
  let repArm=0;
  function resetReport(){ const b=$("cRep"); clearTimeout(repArm); repArm=0; b.disabled=false; b.classList.remove("warn"); b.textContent="REPORT"; b.hidden=!(M&&M.net); }
  $("cRep").addEventListener("click",()=>{ const b=$("cRep"); if(!(M&&M.net)) return;
    if(!repArm){ b.classList.add("warn"); b.textContent="TAP AGAIN TO REPORT"; repArm=setTimeout(resetReport,3000); return; }
    clearTimeout(repArm); repArm=-1; b.classList.remove("warn"); b.disabled=true; b.textContent="SENDING\u2026";
    Promise.resolve(host.report&&host.report()).then(r=>{ if(r&&r.error){ toast(r.error); resetReport(); return; } b.textContent="REPORTED"; toast("Thanks. We'll take a look."); }).catch(()=>{ toast("Couldn't send. Try again."); resetReport(); }); });
  function openChat(o){ $("chat").hidden=!o; if(o){ $("chatDot").hidden=true; if(SW>=900) $("sayI").focus(); } else $("sayI").blur(); }
  $("chatB").addEventListener("click",()=>openChat($("chat").hidden));
  $("sayF").addEventListener("submit",e=>{ e.preventDefault(); const i=$("sayI"); if(i.value.trim()) meSay(i.value); i.value=""; if(SW<900) openChat(false); });
  sky.addEventListener("pointerdown",skyDown); sky.addEventListener("pointermove",skyMove); sky.addEventListener("pointerup",skyUp); sky.addEventListener("pointercancel",()=>drag=null);
  $("bBoost").addEventListener("click",()=>{ act("b"); coachAfter("b"); }); $("bDump").addEventListener("click",()=>{ act("d"); coachAfter("d"); });
  $("bOut").addEventListener("click",()=>{ const had=!!(G&&G.me&&G.me.pos); act("x"); if(had) coachAfter("x"); });
  const keys={l:false,r:false,u:false,dn:false};
  const KEYMAP={a:"l",arrowleft:"l",d:"r",arrowright:"r",w:"u",arrowup:"u",s:"dn",arrowdown:"dn"};
  on(window,"keyup",e=>{const m=KEYMAP[e.key.toLowerCase()]; if(m) keys[m]=false;});
  on(window,"keydown",e=>{
    if($("intro").hidden===false||$("vs").hidden===false||$("search").hidden===false||$("invite").hidden===false){ if(e.target&&(e.target.id==="joinI"||e.target.id==="budI")) return; }
    if(e.target&&e.target.id==="sayI"){ if(e.key==="Escape") openChat(false); return; }
    if(e.key.toLowerCase()==="t"&&!e.repeat&&!(G&&G.solo)){ e.preventDefault(); openChat(true); return; }
    if(e.key==="Escape"&&!$("chat").hidden){ openChat(false); return; }
    const k=e.key.toLowerCase(), m=KEYMAP[k];
    if(m){ e.preventDefault(); keys[m]=true; return; }
    if(e.repeat) return;
    const live=G&&G.started&&!G.over;
    if(k===" "){ if(live){e.preventDefault();act("b");coachAfter("b");} }
    else if(k==="shift"){ if(live){e.preventDefault();act("d");coachAfter("d");} }
    else if(k==="enter"){ if(live){e.preventDefault();const had=!!(G&&G.me&&G.me.pos);act("x");if(had)coachAfter("x");} }

    else if(k==="q"){trick(G&&G.me,"spin");}
    else if(k==="e"){trick(G&&G.me,"flip");}
    else if(k>="1"&&k<="4"){setStake(SIZES[+k-1]);}
  });
  setMute(muted);
  resize(); newGame(); ui(); requestAnimationFrame(frame);
  show("intro");

  /* ---------- share the result (maker 2026-11-15: share card + rematch link; bragging rights only, never rewards) ---------- */
  let LAST=null;
  function shareLine(r){
    const m="$"+Math.abs(r.pm-r.pb).toFixed(2), who=r.bot?`the ${r.opp} bot`:r.opp;
    if(r.tie) return `dead even with ${who} after ${r.len.toLowerCase()} of 50x BTC. tiebreaker?`;
    if(r.win&&r.sat) return `sat out the whole ${r.len.toLowerCase()} duel and still beat ${who} by ${m}. patience is a strategy`;
    if(r.win) return `cooked ${who} by ${m} in a ${r.len.toLowerCase()} BTC duel. run it back?`;
    return `${who} got me by ${m} in a ${r.len.toLowerCase()} BTC duel. 50x humbles everyone. who's next?`;
  }
  /** 1080x1350 card: sky, both rockets (higher = winning), the margin, the line, the link */
  function shareCard(r){
    const W=1080,H=1350,c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
    const sk=imgs[SKY_ORDER[Math.min(2,SKY_ORDER.length-1)]], sky=sk&&sk.complete&&sk.width?sk:imgs.sky1;
    if(sky&&sky.complete&&sky.width){ const k=Math.max(W/sky.width,H/sky.height); x.drawImage(sky,(W-sky.width*k)/2,(H-sky.height*k)/2,sky.width*k,sky.height*k); } else { x.fillStyle="#0B0C1E"; x.fillRect(0,0,W,H); }
    const g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,"rgba(7,8,12,.78)"); g.addColorStop(.45,"rgba(7,8,12,.25)"); g.addColorStop(1,"rgba(7,8,12,.92)"); x.fillStyle=g; x.fillRect(0,0,W,H);
    const rk=imgs.rocket, rh=420, rw=rh*221/609, lead=r.tie?0:r.win?1:-1;
    const rocket=(cx,cy,col)=>{ const fg=x.createRadialGradient(cx,cy+rh*.55,4,cx,cy+rh*.75,170); fg.addColorStop(0,"rgba(255,250,235,.95)"); fg.addColorStop(.3,`rgba(${col},.85)`); fg.addColorStop(1,`rgba(${col},0)`);
      x.globalCompositeOperation="lighter"; x.fillStyle=fg; x.beginPath(); x.ellipse(cx,cy+rh*.72,62,190,0,0,Math.PI*2); x.fill(); x.globalCompositeOperation="source-over";
      if(rk&&rk.complete&&rk.width) x.drawImage(rk,cx-rw/2,cy-rh/2,rw,rh); };
    rocket(360,700-lead*90,"242,193,78"); rocket(720,700+lead*90,"240,48,127");
    x.textAlign="center"; x.textBaseline="alphabetic";
    x.font=`italic 800 64px ${GF},sans-serif`; x.fillStyle="#F2F3F7"; x.fillText("DISCIPLE",W/2,110);
    x.font=`800 30px ${GF},sans-serif`; x.fillStyle="rgba(215,217,228,.85)"; x.fillText(`TRADING DUEL · BTC · ${r.len} · ${LEV}×`,W/2,160);
    x.font=`800 150px ${GF},sans-serif`; x.fillStyle=r.tie?"#F2F3F7":r.win?"#F2C14E":"#FF8FBD"; x.fillText(r.tie?"DRAW":r.win?"YOU WIN":"YOU LOSE",W/2,330);
    if(!r.tie){ x.font=`800 54px ${GF},sans-serif`; x.fillStyle="#F2F3F7"; x.fillText(`${r.win?"WON":"LOST"} BY $${Math.abs(r.pm-r.pb).toFixed(2)}`,W/2,400); }
    x.font=`800 40px ${GF},sans-serif`; x.fillStyle="#F2C14E"; x.fillText("YOU",360,1020); x.fillStyle="#FF8FBD"; x.fillText(r.opp.toUpperCase()+(r.bot?" · BOT":""),720,1020);
    x.font=`700 36px ${GU},sans-serif`; x.fillStyle="#F2F3F7"; x.fillText(usd(r.pm,true),360,1066); x.fillText(usd(r.pb,true),720,1066);
    x.font=`600 34px ${GU},sans-serif`; x.fillStyle="#D7D9E4"; const line=shareLine(r), words=line.split(" "); let row="", y=1160;
    for(const w of words){ const t=row?row+" "+w:w; if(x.measureText(t).width>W-160){ x.fillText(row,W/2,y); row=w; y+=46; } else row=t; } if(row) x.fillText(row,W/2,y);
    x.font=`800 38px ${GF},sans-serif`; x.fillStyle="#F2C14E"; x.fillText("1V1 ME · DISCIPLE.VIP",W/2,H-60);
    return c;
  }
  async function shareResult(){ sfx("shutter"); track("duel_share");
    if(!LAST) return;
    const btn=$("rShare"); btn.disabled=true; const was=btn.textContent; btn.textContent="…";
    try{
      // signed in: a fresh friend link, so whoever taps it lands in a duel against you (30 min); otherwise the site
      let url=location.origin+(host.guest?"/duel":"/");
      if((SIGNED||host.guest)&&host.challengeLink){ try{ const u=await host.challengeLink(botKey,LEN,M&&M.fuel||undefined); if(u) url=u; }catch(e){} }
      const text=shareLine(LAST)+((url.includes("?c=")||url.includes("/vs/"))?" 1v1 me:":"");
      let file=null; try{ const blob=await new Promise(res=>shareCard(LAST).toBlob(res,"image/png")); if(blob) file=new File([blob],"disciple-duel.png",{type:"image/png"}); }catch(e){}
      if(navigator.share){
        const d=file&&navigator.canShare&&navigator.canShare({files:[file]})?{files:[file],text:text+" "+url}:{text,url};
        try{ await navigator.share(d); return; }catch(e){ if(e&&e.name==="AbortError") return; }
      }
      try{ await navigator.clipboard.writeText(text+" "+url); toast("Copied. Paste it anywhere."); }catch(e){ toast(url); }
    } finally { btn.disabled=false; btn.textContent=was; }
  }

  /* first-duel coach (teach by playing, Grok playbook pick, maker 2026-11-16): at GO a finger taps BOOST, after the first trade
     it moves to the cash-out pill, and after the first cash-out it's gone for good (localStorage disciple.duelcoach.v1 = "done") */
  const COACH_KEY="disciple.duelcoach.v1", HAND='<svg class="coachf" viewBox="0 0 44 52" aria-hidden="true"><path d="M16 6a4 4 0 0 1 8 0v16l2-1a4 4 0 0 1 5 2l1 1a4 4 0 0 1 5 2l.5.8A4 4 0 0 1 42 30v8c0 8-6 13-14 13h-3c-5 0-8-2-11-6L6 34a4 4 0 0 1 6-5l4 4V6z" fill="#FFF6DC" stroke="#121327" stroke-width="2" stroke-linejoin="round"/></svg>';
  const coachStep=()=>{ try{ return localStorage.getItem(COACH_KEY)||""; }catch(e){ return "done"; } };
  function coach(step){
    for(const id of ["bBoost","bOut","bDump"]){ const b=$(id); b.classList.remove("coached"); b.querySelectorAll(".coachf,.coachb").forEach(n=>n.remove()); }
    try{ if(step) localStorage.setItem(COACH_KEY,step); }catch(e){}
    if(!step||step==="done") return;
    // the cash-out pill already reads TAP TO CASH OUT, so that step is the finger alone (maker 2026-11-17: "tap to cash out twice")
    const b=$(step==="out"?"bOut":"bBoost"); b.classList.add("coached");
    b.insertAdjacentHTML("beforeend",(step==="out"?"":'<span class="coachb" aria-hidden="true"><b>TAP BOOST</b><small>you win if the price goes up</small></span>')+HAND);
  }
  function coachAfter(kind){ if(!G||!G.started||G.over) return; const st=coachStep(); if(st==="done") return; if(kind==="x") coach("done"); else if(kind==="b"||kind==="d") coach("out"); }

  /* the first-win crate on the result card. d = {state:"locked"|"opened", crate, open?, item?, color?, rar?} (art URLs from the host) */
  let crateT=0;
  function firstCrate(d){
    const box=$("rCrate"), ci=$("rCrateImg"), it=$("rCrateItem");
    if(!d){ box.hidden=true; return; }
    clearTimeout(crateT); box.classList.remove("drop","open"); it.hidden=true; box.style.removeProperty("--fc");
    ci.src=d.crate; void box.offsetWidth; box.hidden=false; box.classList.add("drop"); sfx("crate");
    if(d.state==="locked"){
      $("rCrateK").textContent="FIRST WIN CRATE"; $("rCrateN").textContent="IT'S YOURS"; $("rCrateS").textContent="Save your win to open it."; return;
    }
    $("rCrateK").textContent="FIRST WIN CRATE"; $("rCrateN").textContent="OPENING\u2026"; $("rCrateS").textContent="";
    crateT=setTimeout(()=>{
      if(d.open) ci.src=d.open;
      it.src=d.item||""; it.hidden=!d.item; box.style.setProperty("--fc",d.color||"var(--gold)"); box.classList.add("open"); sfx("crateOpen"); buzz([20,30,40]);
      $("rCrateK").textContent=(d.rar||"").toUpperCase()+(d.kind?" \u00b7 "+d.kind.toUpperCase():""); $("rCrateN").textContent=d.name||"NEW ITEM"; $("rCrateS").textContent="In your Hangar now.";
    },reduce?0:1100);
  }

  // first launch of the app (maker 2026-11-15: "straight into a bot duel"): skip the lobby, 1 MIN against the rookie bot
  if(host.first){ botKey="rookie"; setTimeout(()=>{ practice(); setTimeout(()=>{ if(!$("vs").hidden) $("vReady").click(); },700); },300); }

  /* ---------- Climb: solo Turbo (maker 2026-11-17/18) ----------
     Five levels you keep. Each is a fuel, a gear and a $ goal in 60 s. Hit the goal once and the next level unlocks; beat a
     higher level's $ goal and you jump to it. After level 5 is free mode: any fuel, up to 50x, no clock. Levels and
     the unlock rule live in lib/climb/rules.ts (host.climb); this block only draws and flies. */
  const CLIMB_CSS=".duel-root .cslide{display:none}.duel-root.cfree .size.pct>button{display:none}"
    +".duel-root.cfree .cslide{display:flex;flex:1;align-items:center;gap:14px;padding:0 6px}"
    +".duel-root .cslide input{flex:1;-webkit-appearance:none;appearance:none;height:8px;border-radius:99px;background:linear-gradient(90deg,var(--gold) var(--p,25%),rgba(255,255,255,.14) var(--p,25%));outline:none}"
    +".duel-root .cslide input::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;border-radius:50%;background:var(--gold);border:3px solid #121327;box-shadow:0 0 0 2px var(--gold);cursor:pointer}"
    +".duel-root .cslide input::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:var(--gold);border:3px solid #121327;cursor:pointer}"
    +".duel-root .cslide b{min-width:64px;text-align:right;font:800 20px/1 var(--f-game);color:var(--text);display:flex;flex-direction:column;align-items:flex-end;gap:2px}.duel-root .cslide b .u{font:600 11px/1 var(--f-ui,sans-serif);color:var(--muted)}"
    +".duel-root.climb #slotR,.duel-root.climb #aVs,.duel-root.climb #aRadar,.duel-root.climb .steps,.duel-root.climb #chatB,.duel-root.climb #chat,.duel-root.climb #vMeR,.duel-root.climb .arena .tag.me{display:none!important}"
    +".duel-root .land{width:auto;padding:0 12px;font:800 16px/1 var(--f-game);letter-spacing:1px;color:var(--text)}"
    +".duel-root .choices.ladder{gap:6px}.duel-root .lchips{display:flex;flex-wrap:wrap;gap:5px}.duel-root .lc{padding:4px 7px 3px;border-radius:7px;background:rgba(255,255,255,.07);color:#C9CED6;font:700 12px/1 var(--f-game);letter-spacing:.08em;font-style:normal;white-space:nowrap}.duel-root .lc.ok{background:rgba(95,240,160,.14);color:var(--green)}.duel-root .choice.main .lc{background:rgba(18,19,39,.12);color:#121327}.duel-root .lgoal{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:64px}.duel-root .lgoal small{font:700 10px/1 var(--f-game);letter-spacing:.14em;color:var(--muted)}.duel-root .choice .lgoal b{font:800 28px/1 var(--f-game);color:var(--green)}.duel-root .choice.main .lgoal small{color:rgba(18,19,39,.6)}.duel-root .choice.main .lgoal b{color:#121327}.duel-root .choice.lock .lgoal{opacity:.5}.duel-root .choices.ladder .choice{min-height:0;padding-top:8px;padding-bottom:8px}"
    +".duel-root .choice.lock .ci,.duel-root .choice.lock .ct{opacity:.5}.duel-root .choice.done .ci{color:var(--green)}"
    +".duel-root .cbig{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0 10px;text-align:center}"
    +".duel-root .cbig small{font:700 14px/1 var(--f-game);letter-spacing:1.5px;color:var(--muted)}"
    +".duel-root .cbig b{font:800 64px/1 var(--f-game);color:var(--gold)}.duel-root .cbig b.dn{color:var(--pinkl)}.duel-root .cbig b.up{color:var(--green)}"
    +".duel-root .cbig strong{font:800 26px/1 var(--f-game);color:var(--text)}.duel-root .cbig em{font:700 15px/1.2 var(--f-game);font-style:normal;letter-spacing:.8px;color:var(--green)}";
  const ICO={bolt:'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    check:'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
    lock:'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    go:'<svg class="cgo" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'};
  const gx=g=>g+"×", m2=v=>"$"+(v>=1000?v.toLocaleString("en-US"):v%1?v.toFixed(2):String(v));
  const LVS=CL?CL.levels:[], FREE=LVS.length+1, MAXG=CL?CL.maxGear:50;
  const lvl=n=>LVS.find(l=>l.n===n)||null;
  const pctOf=l=>"+"+(l.pct!=null?l.pct:Math.round(l.goal/l.fuel*1000)/10)+"%";
  let cFree={fuel:LVS.length?LVS[LVS.length-1].fuel:100,gear:MAXG}, cFreeSet=false;
  function climbChip(){ const u=CL.state().unlocked, l=lvl(u);
    $("lRat").textContent=u>=FREE?"FREE":"LVL "+u; $("lRec").textContent=l?`${m2(l.fuel)} · ${gx(l.gear)}`:`${gx(MAXG)} MAX`; }
  function climbHome(err){ clearInterval(pwIv); if(CLR&&CL.lighter) CL.lighter.end(); M=null; CLR=null; show("climb"); climbChip();
    const u=CL.state().unlocked, rows=[];
    const fr=u>=FREE;
    rows.push(`<button class="choice${fr?" main":" lock"}" type="button" data-cl="free">${`<i class="ci">${fr?ICO.bolt:ICO.lock}</i>`}<span class="ct"><b>FREE MODE</b><span class="lchips"><em class="lc">${gx(MAXG)} MAX</em><em class="lc">NO CLOCK</em></span></span>${fr?ICO.go:""}</button>`);
    for(const l of LVS.slice().reverse()){ const k=l.n>u?"lock":l.n===u?"cur":"done";
      rows.push(`<button class="choice${k==="cur"?" main":""} ${k}" type="button" data-cl="${l.n}"><i class="ci">${k==="lock"?ICO.lock:k==="done"?ICO.check:ICO.bolt}</i><span class="ct"><b>LEVEL ${l.n}</b><span class="lchips"><em class="lc">${m2(l.fuel)} FUEL</em><em class="lc">${gx(l.gear)}</em><em class="lc">1 MIN</em>${k==="done"?'<em class="lc ok">CLEARED</em>':""}</span></span><span class="lgoal" title="Make ${m2(l.goal)} in a minute"><small>TARGET</small><b>${pctOf(l)}</b></span>${k==="cur"?ICO.go:""}</button>`); }
    $("climb").innerHTML=(typeof err==="string"&&err?`<p class="lerr" role="status">${esc(err)}</p>`:"")+`<div class="choices ladder">${rows.join("")}</div>`;
    $("climb").querySelectorAll("[data-cl]").forEach(b=>b.addEventListener("click",()=>{ ensureAudio(); const v=b.dataset.cl;
      if(v==="free"){ if(CL.state().unlocked>=FREE) climbFreeSetup(); else toast("Clear level "+LVS.length+" to unlock free mode."); return; }
      const n=+v; if(n<=CL.state().unlocked){ climbPlay(n); return; }
      toast("Clear level "+(n-1)+" first."); })); }   // no test out (maker 2026-11-18: "that ruins the fun")
  function climbFreeSetup(){ show("cres");
    const fuels=LVS.map(l=>l.fuel), gears=[]; for(let g=10;g<=MAXG;g+=10) gears.push(g);
    const opt=(k,v,lab)=>`<button class="opt${cFree[k]===v?" on":""}" type="button" data-${k}="${v}">${lab}</button>`;
    $("cres").innerHTML=`<div class="opts" role="group" aria-label="Fuel"><span>FUEL</span>${fuels.map(f=>opt("fuel",f,m2(f))).join("")}</div>`
      +`<div class="opts" role="group" aria-label="Gear"><span>GEAR</span>${gears.map(g=>opt("gear",g,gx(g)+`<small class="ob">NUKE −${Math.round(LIQ/g*1000)/10}%</small>`)).join("")}</div>`
      +`<div class="choices"><button class="choice main" type="button" id="cFly"><i class="ci">${ICO.bolt}</i><span class="ct"><b>FLY · ${gx(cFree.gear)}</b><small>${m2(cFree.fuel)} fuel · no clock</small></span>${ICO.go}</button></div>`
      +`<button class="sec wide" type="button" id="cBack" style="margin-top:8px">LEVELS</button>`;
    $("cres").querySelectorAll("[data-fuel],[data-gear]").forEach(b=>b.addEventListener("click",()=>{ if(b.dataset.fuel){ cFree.fuel=+b.dataset.fuel; cFreeSet=true; } if(b.dataset.gear) cFree.gear=+b.dataset.gear; climbFreeSetup(); }));
    $("cBack").addEventListener("click",climbHome);
    $("cFly").addEventListener("click",()=>climbPlay(FREE)); }
  function climbPlay(n,test){ const l=lvl(n), free=n>=FREE;
    CLR=free?{level:FREE,free:true,fuel:cFree.fuel,gear:cFree.gear,goal:null,len:Infinity}:{level:n,test:!!test,fuel:l.fuel,gear:l.gear,goal:l.goal,len:CL.runMs};
    M={net:false,ranked:false,solo:true}; OFF=0; show("launch"); climbPanel();
    if(CL.lighter) CL.lighter.begin({fuel:CLR.fuel,gear:CLR.gear});
    waitForPrice(()=>{ if(!M||!M.solo) return; M.startAt=Date.now()+3500; if(CL.lighter) CL.lighter.arm(M.startAt+(isFinite(CLR.len)?CLR.len:270000)); start(); }); }
  function climbPanel(){ $("lCancel").hidden=false;
    $("lH").textContent=CLR.free?"FREE MODE":"LEVEL "+CLR.level;
    $("lSub").textContent=`${m2(CLR.fuel)} · ${gx(CLR.gear)}`+(CLR.goal!=null?` · make +${m2(CLR.goal)}`:" · no clock")+(CL.real?"":" · play money"); }
  function climbLaunch(){ root.classList.add("climb"); climbPanel();
    const who=$("meN").parentElement; who.innerHTML=(CLR.free?"FREE · ":`LEVEL ${CLR.level} · ${m2(CLR.fuel)} · `)+`<span id="meN" style="color:var(--gold)">${gx(CLR.gear)}</span>`;
    const nx=lvl(CLR.level+1); $("botLab").innerHTML=(CLR.free?"FUEL":"TO GOAL")+'<span id="botN"></span>';
    $("botP").textContent=CLR.free?m2(CLR.fuel):"0%"; $("botP").style.color="var(--gold)";
    $("landB").hidden=!CLR.free;
    // free mode: one slider, 1-100% of the fuel you have left, instead of the 10/25/50/ALL buttons (maker 2026-11-18)
    root.classList.toggle("cfree",!!CLR.free);
    if(CLR.free&&!$("cSlI")){ const g=root.querySelector(".size.pct"); if(g){ g.insertAdjacentHTML("beforeend",'<label class="cslide"><input id="cSlI" type="range" min="1" max="100" step="1" aria-label="Position size, % of fuel"><b id="cSlV"></b></label>');
      $("cSlI").addEventListener("input",e=>{ cPct=+e.target.value; setStake(cPct>=100?0:cPct); }); } }
    if(CLR.free) stake=cPct>=100?0:cPct; paintSizes(); }
  function soloUi(){ const p=profitOf(G.me), li=$("leadI");
    // top right: how far to this level's goal (maker 2026-11-18), green once you're past it
    if(CLR.free){ $("botP").textContent=m2(CLR.fuel); $("botP").style.color="var(--gold)"; }
    else { const pc=Math.max(0,Math.round(p/CLR.goal*100)); $("botP").textContent=pc+"%"; $("botP").style.color=pc>=100?"var(--green)":"var(--gold)"; }
    if(CLR.free){ $("clock").textContent=mmss(Math.max(0,G.t)); li.style.width="0"; $("leadT").textContent=""; return; }
    const pr=Math.max(0,Math.min(1,p/CLR.goal)); li.style.left="0%"; li.style.width=Math.max(2,pr*100)+"%"; li.style.background="var(--green)";
    $("leadT").textContent="GOAL +"+m2(CLR.goal); $("leadT").style.color="var(--green)"; }
  // the sky for a level run (maker 2026-11-18: "make the target way visually higher so it feels like you're climbing"):
  // START sits low, the GOAL gate near the top, and the first cents move the rocket the most (ease-out), so every tick
  // up reads as climbing closer. Past the goal you keep rising toward the top edge; losses sink toward the NUKE.
  const SOLO_START=.78, SOLO_GOAL=.14;
  function soloFrac(v){ const me=G.me, pos=me.pos;
    if(CLR.goal!=null){ const u=v/CLR.goal;
      if(u>=1) return SOLO_GOAL-SOLO_GOAL*.85*Math.tanh((u-1)*1.5);
      if(u>=0) return SOLO_START-(SOLO_START-SOLO_GOAL)*(1-Math.pow(1-u,1.7));
      const lossTo=pos?LIQ*pos.coll:CLR.goal*3; return SOLO_START+(1-SOLO_START)*Math.min(1.05,Math.pow(-v/lossTo,.75)); }
    const r=Math.max(CLR.fuel*.01,Math.abs(profitOf(me))*1.5,.5); G.sR=G.sR==null?r:G.sR+(r-G.sR)*.03;
    return .5-.42*Math.max(-1.1,Math.min(1.1,v/G.sR)); }
  // level runs fly a tall sky (maker 2026-11-18: "the line needs to be way taller ... i shouldn't see either line on my
  // screen at the start"): PnL maps to sky heights, measured in rooms (one room = the visible sky). The GOAL gate is
  // SOLO_UP rooms above START and the NUKE SOLO_DN rooms below it, so both start off screen. The camera follows the
  // rocket a beat behind, which is what makes the clouds and stars rush past while you climb.
  const SOLO_UP=2.4, SOLO_DN=1.7, SOLO_ANCHOR=.84, SOLO_TOP=.14, SOLO_BOT=.9;
  function soloW(v){ if(CLR.goal==null) return 0; const u=v/CLR.goal;
    if(u>=0) return SOLO_UP*(1-Math.pow(1-Math.min(u,1),1.35))+Math.max(0,u-1)*1.2;   // ease-out: the first cents climb the most
    const lossTo=G.me.pos?LIQ*G.me.pos.coll:CLR.goal*3; return -SOLO_DN*Math.pow(Math.min(1.2,-v/lossTo),.7); }
  function soloRoom(){ const a=LAY.under+40, z=LAY.barTop-10; return [a,z,z-a]; }
  function soloYOf(v){ const [a,z,H]=soloRoom();
    if(CLR.goal==null) return a+soloFrac(v)*(z-a);
    return a+SOLO_ANCHOR*H-(soloW(v)-(G.camW||0))*H; }
  function soloProg(){ return CLR.goal!=null?Math.max(0,profitOf(G.me)/CLR.goal):0; }
  function soloY(){ const [a,z,H]=soloRoom();
    if(CLR.goal!=null){ const w=soloW(profitOf(G.me)); G.rW=G.rW==null?w:G.rW+(w-G.rW)*.1;
      // maker 2026-11-18: "the rocket should be able to go up and down the full height of the screen". It starts low
      // (SOLO_ANCHOR) and flies freely between SOLO_TOP and SOLO_BOT; past those the camera scrolls with it.
      const c0=G.camW==null?0:G.camW, fr=SOLO_ANCHOR-(G.rW-c0); let ct=c0;
      if(fr<SOLO_TOP) ct=G.rW-(SOLO_ANCHOR-SOLO_TOP); else if(fr>SOLO_BOT) ct=G.rW-(SOLO_ANCHOR-SOLO_BOT);
      G.camW=c0+(ct-c0)*.08; G.me.sVy=-(G.camW-c0)*H;   // px the camera moved this frame (negative = climbing)
      if(G.me.sVy<-.3) G.me.flame=Math.min(2.2,G.me.flame+Math.min(.15,-G.me.sVy*.03));
      return a+SOLO_ANCHOR*H-(G.rW-G.camW)*H+(G.me.syo||0)*.2; }
    const t=soloYOf(profitOf(G.me)), was=G.me.sY; G.me.sY=was==null?t:was+(t-was)*.12; G.me.sVy=was==null?0:G.me.sY-was;
    return G.me.sY+(G.me.syo||0)*.2; }
  // height: $ marks up the sky between START and the GOAL, and the duel's gap ruler from START up to your rocket
  // the right edge for labels at height y, moved left past the mute button when they'd sit under it
  function soloRight(y,hh){ const m=$("mute"), c=sky.getBoundingClientRect(); if(!m||m.hidden) return SW-12; const r=m.getBoundingClientRect(), t=r.top-c.top, b=r.bottom-c.top;
    return y+hh>t-4&&y<b+4?r.left-c.left-10:SW-12; }
  function soloHeight(){ if(CLR.goal==null) return; const g=CLR.goal, top=LAY.under, p=profitOf(G.me), yS=soloYOf(0), yG=soloYOf(g);
    sx.font="700 11px "+GF+",sans-serif"; sx.textAlign="right"; sx.textBaseline="bottom";
    let lastY=-1e9; for(let i=6;i>=1;i--){ if(i===4) continue; const v=g*i/4, y=soloYOf(v); if(y<top||y>SH||y-lastY<30||Math.abs(y-yS)<26||Math.abs(y-yG)<26) continue; lastY=y;
      sx.strokeStyle=v>0?"rgba(95,240,160,.16)":"rgba(255,143,189,.16)"; sx.lineWidth=1; sx.setLineDash([3,7]); sx.beginPath(); sx.moveTo(0,y); sx.lineTo(SW,y); sx.stroke(); sx.setLineDash([]);
      sx.fillStyle=v>0?"rgba(95,240,160,.75)":"rgba(255,143,189,.75)"; sx.fillText((v>0?"+$":"\u2212$")+Math.abs(v).toFixed(2),soloRight(y-14,14),y-3); }
    if(Math.abs(p)<.005) return;
    // a tether from START to the rocket's tail, so the climb reads as height gained
    const a=G.me, x=lane(a)+(a.dx||0), y0=Math.max(top,Math.min(SH,soloYOf(0))), y1=a.y+(p>0?RH()*.62:-RH()*.55); if(Math.abs(y1-y0)<24) return;
    const t0=Math.min(y0,y1), t1=Math.max(y0,y1), col=p>0?"95,240,160":"255,143,189";
    sx.strokeStyle=`rgba(${col},.6)`; sx.lineWidth=2; sx.setLineDash([4,5]); sx.beginPath(); sx.moveTo(x,t0); sx.lineTo(x,t1); sx.stroke(); sx.setLineDash([]);
    sx.beginPath(); sx.moveTo(x-6,t0); sx.lineTo(x+6,t0); sx.moveTo(x-6,t1); sx.lineTo(x+6,t1); sx.stroke();
    const t=(p>0?"+":"\u2212")+"$"+Math.abs(p).toFixed(2); sx.font="800 16px "+GF+",sans-serif";
    const w=sx.measureText(t).width+12, my=Math.max(t0+40,Math.min(t1-40,Math.min((t0+t1)/2,LAY.barTop-30))); if(t1-t0>90){ sx.fillStyle=`rgba(${col},.95)`; rr(x-w/2,my-11,w,22,8); sx.fill();
    sx.fillStyle="#121327"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(t,x,my+1); } }
  function soloLines(){ soloHeight(); const me=G.me, pos=me.pos, p=profitOf(me), top=LAY.under+6, bot=LAY.barTop+10, f=n=>Math.round(n).toLocaleString("en-US");
    const L=[{v:0,label:"START",plain:1,col:"242,243,247"}];
    const priceAt=v=>pos?pos.entry*(1+pos.side*(v-(p-pnlOf(pos,G.price)))/pos.size):null;   // the price at which your profit reads v
    if(CLR.goal!=null) L.push({v:CLR.goal,label:"GOAL +"+m2(CLR.goal),sub:pos?f(priceAt(CLR.goal)):null,col:"95,240,160",gate:1,w:3});
    if(pos){ const nv=p-pnlOf(pos,G.price)-LIQ*pos.coll, np=pos.entry*(1-pos.side*LIQ*pos.coll/pos.size);
      L.push({v:nv,label:"NUKE",pin:"NUKE "+f(np)+" · "+usd(-LIQ*pos.coll),sub:f(np),col:"240,48,127",ink:"#fff",band:60}); }
    for(const l of L){ let y=soloYOf(l.v), pin=0; if(CLR.goal!=null&&(y<top-30||y>bot+30)) continue; if(y<top){y=top;pin=-1;} if(y>bot){y=bot;pin=1;}
      if(l.plain){ if(pin) continue; sx.strokeStyle="rgba(255,255,255,.45)"; sx.lineWidth=1.5; sx.setLineDash([6,5]); sx.beginPath(); sx.moveTo(0,y); sx.lineTo(SW,y); sx.stroke(); sx.setLineDash([]);
        sx.font="700 11px "+GF+",sans-serif"; sx.textAlign="right"; sx.textBaseline="bottom"; sx.fillStyle="rgba(242,243,247,.85)"; sx.fillText(l.label,soloRight(y-14,14),y-3); continue; }
      if(!pin){ if(l.band){ const g=sx.createLinearGradient(0,y,0,y+l.band); g.addColorStop(0,`rgba(${l.col},.28)`); g.addColorStop(1,`rgba(${l.col},0)`); sx.fillStyle=g; sx.fillRect(0,y,SW,l.band); }
        if(l.gate){ const g=sx.createLinearGradient(0,y-26,0,y+26); g.addColorStop(0,`rgba(${l.col},0)`); g.addColorStop(.5,`rgba(${l.col},.22)`); g.addColorStop(1,`rgba(${l.col},0)`); sx.fillStyle=g; sx.fillRect(0,y-26,SW,52); }
        sx.strokeStyle=`rgba(${l.col},.9)`; sx.lineWidth=l.w||2; sx.beginPath(); sx.moveTo(0,y); sx.lineTo(SW,y); sx.stroke(); }
      const txt=(pin<0?"▲ ":pin>0?"▼ ":"")+(pin&&l.pin?l.pin:l.label); sx.font="800 14px "+GF+",sans-serif"; const tw=sx.measureText(txt).width+16, hh=22, ly=pin<0?y:pin>0?y-hh:y-hh/2;
      // right-aligned: the trade feed lives top left
      let sw=0; if(l.sub&&!pin){ sx.font="700 12px "+GF+",sans-serif"; sw=sx.measureText(l.sub).width+12; }
      const x1=soloRight(ly,hh)-tw; sx.font="800 14px "+GF+",sans-serif";
      sx.fillStyle=`rgba(${l.col},.95)`; rr(x1,ly,tw,hh,7); sx.fill(); sx.fillStyle=l.ink||"#121327"; sx.textAlign="left"; sx.textBaseline="middle"; sx.fillText(txt,x1+8,ly+hh/2+1);
      if(sw){ const x2=x1-4-sw; sx.font="700 12px "+GF+",sans-serif"; sx.fillStyle="rgba(11,10,22,.86)"; rr(x2,ly+2,sw,hh-4,6); sx.fill(); sx.fillStyle=`rgba(${l.col},1)`; sx.fillText(l.sub,x2+6,ly+hh/2+1); } } }
  // On Lighter (host.climb.lighter.result) the run's result is the real money: the account's cash after the close
  // minus before the run, read back from Lighter (at most ~6 s); the game's own number only if Lighter can't say
  function climbEnd(){ G.over=true; if(G.me.pos) close(G.me); const lx=CL.lighter; const done=lx?lx.end():null; music(false); ui();
    const game=profitOf(G.me);
    if(lx&&lx.result){ const g=G; Promise.race([Promise.resolve(done).then(()=>lx.result()),new Promise(r=>setTimeout(()=>r(null),6000))])
      .catch(()=>null).then(v=>{ if(dead||G!==g) return; climbResult(typeof v==="number"&&isFinite(v)?v:game); }); return; }
    climbResult(game); }
  function climbResult(pnl){ if(!CLR) return; const run=CLR, before=CL.state().unlocked;
    const res=run.free?{unlocked:before}:CL.finish({level:run.level,pnl,test:run.test});
    const up=res.unlocked>before, n=res.unlocked, nl=lvl(n), clr=!run.free&&cHit(pnl);
    setTimeout(()=>{ if(dead) return; show("cres"); climbChip(); sfx(up||clr?"win":"lose");
      let big;
      if(run.free) big=`<small>LANDED</small><b class="${pnl>=0?"up":"dn"}">${usd(pnl,true)}</b><strong>${m2(run.fuel)} · ${gx(run.gear)}</strong>`;
      else if(up) big=`<small>${n-run.level>1?"LEVEL JUMP":"LEVEL UP"}</small><b>${n>=FREE?"FREE MODE":"LEVEL "+n}</b><strong>${n>=FREE?"UNLOCKED":`${m2(nl.fuel)} · ${gx(nl.gear)} UNLOCKED`}</strong><em>${usd(pnl,true)}${nl?` · NEXT GOAL +${m2(nl.goal)}`:""}</em>`;
      else if(clr) big=`<small>CLEARED</small><b class="up">${usd(pnl,true)}</b><em style="color:var(--muted)">GOAL +${m2(run.goal)}</em>`;
      else big=`<small>${G.nuked?"NUKED":"MISSED"}</small><b class="${pnl>=0?"up":"dn"}">${usd(pnl,true)}</b><em style="color:var(--muted)">GOAL +${m2(run.goal)}</em>`;
      const again=run.free?"FLY AGAIN":up?(n>=FREE?"FREE MODE":"PLAY LEVEL "+n):"AGAIN";
      const sub=run.free?`${m2(run.fuel)} · ${gx(run.gear)}`:up&&nl?`${m2(nl.fuel)} · ${gx(nl.gear)}`:up?`up to ${gx(MAXG)} · no clock`:`${m2(run.fuel)} · ${gx(run.gear)}`;
      $("cres").innerHTML=`<div class="cbig">${big}</div><div class="choices"><button class="choice main" type="button" id="cAgain"><i class="ci">${ICO.bolt}</i><span class="ct"><b>${again}</b><small>${sub}</small></span>${ICO.go}</button></div><button class="sec wide" type="button" id="cBack" style="margin-top:8px">LEVELS</button>`;
      $("cBack").addEventListener("click",climbHome);
      $("cAgain").addEventListener("click",()=>{ ensureAudio(); if(run.free) climbPlay(FREE); else if(up&&n>=FREE) climbFreeSetup(); else climbPlay(up?n:run.level); });
    },G.nuked&&!G.me.fuel?1400:700); }
  if(CL){
    const sty=document.createElement("style"); sty.textContent=CLIMB_CSS; st.after(sty); offs.push(()=>sty.remove());
    const pnl=root.querySelector(".panel"); pnl.insertAdjacentHTML("beforeend",'<div class="pane" id="climb" hidden></div><div class="pane" id="cres" hidden></div>');
    PANES.push("climb","cres");
    $("chatB").insertAdjacentHTML("afterend",'<button class="mute chatb land" id="landB" type="button" hidden>LAND</button>');
    $("landB").addEventListener("click",()=>{ if(G&&G.solo&&G.started&&!G.over) end(); });
    root.classList.add("climb"); const t=root.querySelector(".pre-title"); if(t) t.textContent="CLIMB";
    // BACK: from a test out, free mode setup or a result it goes to the levels; from the levels, to wherever you came from
    const bk=root.querySelector(".pre-back"); if(bk){ if(CL.back) bk.href=CL.back;
      const onBk=e=>{ if(!$("climb").hidden){ let same=false; try{ same=!!document.referrer&&new URL(document.referrer).origin===location.origin; }catch(_){}
          if(same&&history.length>1){ e.preventDefault(); history.back(); } return; }
        e.preventDefault(); if(M&&M.solo&&!$("launch").hidden&&G&&!G.started){ M=null; } climbHome(); };
      bk.addEventListener("click",onBk); offs.push(()=>bk.removeEventListener("click",onBk)); }
    $("lCancel").addEventListener("click",()=>{ if(CLR) climbHome(); });
    climbHome();
  }

  return {
    price:(p,ts)=>pushPrice(p,ts),
    setMe:(rec,signed)=>{ REC=Object.assign({w:0,l:0,rating:1200,streak:0},rec||{}); SIGNED=!!signed; paintLobby(); },
    setClock:(serverNow)=>{ OFF=serverNow-Date.now(); },
    searching:(waitedMs,window_,botOffer)=>{ $("sT").textContent=mmss(waitedMs+999); $("sSub").textContent=`${tierName(botKey)} \u00b7 ${lenTxt()}`+(RL?` \u00b7 ${REC.rating-window_}\u2013${REC.rating+window_}`:""); if(botOffer&&!$("search").hidden){ host.cancelSearch(); practice(); } },   // nobody live after 20 s: start a bot duel on its own (maker 2026-11-18)
    invite:(code,url,share)=>{ $("iCode").textContent="DUEL-"+code; $("iLink").textContent=url.replace(/^https?:\/\//,""); $("iLink").dataset.url=url; $("iLink").dataset.share=share||""; $("iSub").textContent=`FRIEND \u00b7 ${money(CFUEL)} fuel each \u00b7 ${lenTxt()}`; $("iWait").textContent="Waiting for your friend to open the link\u2026"; show("invite"); },
    room:(r,meId)=>{ // lobby state of a server room
      if(r.tier&&TIERS[r.tier]) botKey=r.tier; if(r.lenMs) LEN=Math.min(r.lenMs,60000);
      const o=r.players.find(p=>p.pid!==meId), me=r.players.find(p=>p.pid===meId);
      if(!o) return;
      M={net:true,ranked:r.mode==="ranked",casual:r.mode==="casual",me:meId,opp:{pid:o.pid,name:o.name},startAt:r.startAt,endAt:r.endAt,fuel:r.fuel};
      if(r.status==="lobby"){ const fresh=$("vs").hidden; if(fresh) openVs(r.mode!=="friend"?"MATCH FOUND":"FRIEND JOINED",{name:o.name,rating:o.rating,w:o.record.w,l:o.record.l,ready:o.ready},r.mode==="ranked"&&RL?"ranked":"unranked");
        else { $("vThemR").classList.toggle("on",o.ready); $("vThemR").textContent=o.ready?"READY":"NOT READY"; if(me&&me.ready){ $("vMeR").classList.add("on"); $("vMeR").textContent="READY"; } } }
      else if(r.status==="live"&&(!G||G.startAt!==r.startAt||G.over)){ start(); for(const p of r.players){ const pl=p.pid===meId?G.me:G.bot; if(r.books[p.pid]) setBook(pl,r.books[p.pid]); } if(r.ot){G.ot=true;} ui(); }
      else if(r.status==="cancelled"){ toast(`${esc(o.name)} left the lobby`); M=null; show("intro"); }
    },
    event:(ev)=>onEvent(ev),
    error:(t)=>{ if(!$("intro").hidden) lerr(t); else toast(t); if(!$("search").hidden||!$("invite").hidden){ show("intro"); lerr(t); } if(!$("result").hidden){ $("rAgain").disabled=false; $("rAgain").textContent="REMATCH"; } },
    toLobby:()=>{ M=null; show("intro"); },
    firstCrate:(d)=>firstCrate(d),
    // Climb on Lighter: the real average entry Lighter filled at replaces the game's entry (same side and size)
    climbFill:(entry)=>{ if(!CLR||!G||G.over||!G.me.pos||!(entry>0)) return; G.me.pos.entry=entry; ui(); },
    climbRefresh:()=>{ if(!CL) return; if(!cFreeSet&&LVS.length) cFree.fuel=LVS[LVS.length-1].fuel; if(!$("climb").hidden) climbHome(); },
    _state:()=>G,
    destroy:()=>{ dead=true; if(CL&&CL.lighter) CL.lighter.end(); offs.forEach(f=>f()); removeEventListener("storage",onStore); removeEventListener("disciple:audio",onLvl); try{ if(ac) ac.close(); }catch(e){} root.innerHTML=""; root.classList.remove("duel-root"); },
  };
}
window.DuelEngine={mount};
})();
