/* DISCIPLE Trading Duel screen, ported from the signed-off prototype (https://claude.ai/artifact/SbjfezPzV3PLWMi7qkPMWu). Edit this file directly.
 * window.DuelEngine.mount(root, host) \u2192 api. The host does every server call; see components/turbo/duel/DuelScreen.tsx. */
(function(){
const CSS=".duel-root{\n  --night:#0B0C0E; --ink:#121327; --glass:rgba(18,19,39,.82); --line:rgba(255,255,255,.22);\n  --text:#F2F3F7; --muted:rgba(215,217,228,.85); --gold:#F2C14E; --champ:#F3DFA8; --green:#5FF0A0; --pink:#F0307F; --pinkl:#FF8FBD;\n  --f-game:var(--font-barlow-condensed),'Barlow Condensed','Arial Narrow',system-ui,sans-serif; --f-ui:var(--font-geist),'Geist',system-ui,-apple-system,sans-serif;\n  color-scheme:dark;\n}\n.duel-root *{box-sizing:border-box}\n.duel-root,.duel-root{height:100%;margin:0;background:#07080c}\n.duel-root{color:var(--text);font-family:var(--f-ui);overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}\n.duel-root [hidden]{display:none!important}\n.duel-root button{font:inherit;color:inherit;cursor:pointer}\n.duel-root .stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}\n.duel-root .app{position:relative;width:100%;height:100%;overflow:hidden;background:var(--ink);--ch:136px}\n.duel-root .app.big{--ch:250px}\n@media (min-width:560px){.duel-root .app{width:400px;height:min(100%,860px);border-radius:36px;box-shadow:0 0 0 10px #1b1c22,0 30px 80px rgba(0,0,0,.6)}}\n.duel-root #sky{position:absolute;inset:0;width:100%;height:100%;display:block}\n.duel-root .sb{position:absolute;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;pointer-events:none}\n.duel-root .sb .who{font:700 13px/1 var(--f-game);letter-spacing:.4px;color:var(--champ)}\n.duel-root .sb .who.r{color:var(--muted);text-align:right}\n.duel-root .sb b{display:block;font:800 34px/1 var(--f-game);font-variant-numeric:tabular-nums;text-shadow:0 2px 0 #121327;margin-top:3px}\n.duel-root .sb .r b{text-align:right}\n.duel-root .mid{display:flex;flex-direction:column;align-items:center;gap:4px}\n.duel-root .mid b{font-size:30px;margin:0}\n.duel-root .lead{width:96px;height:8px;border-radius:4px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.4);overflow:hidden;position:relative}\n.duel-root .lead i{position:absolute;top:0;bottom:0;left:50%;background:var(--green);transition:all .25s}\n.duel-root .mid small{font:700 12px/1 var(--f-game);letter-spacing:.4px;color:var(--muted)}\n.duel-root .mid.ot b{color:var(--pinkl)}\n.duel-root .chart{position:absolute;left:12px;right:12px;top:calc(76px + env(safe-area-inset-top,0px));height:var(--ch);border-radius:16px;background:rgba(12,13,28,.80);border:2px solid rgba(255,255,255,.16);overflow:hidden;transition:height .25s ease;padding:0}\n.duel-root .chart canvas{position:absolute;inset:0;width:100%;height:100%}\n.duel-root .chart .lab{position:absolute;left:10px;top:7px;font:700 12px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);pointer-events:none}\n.duel-root .chatb{top:calc(var(--ch) + 138px + env(safe-area-inset-top,0px))!important}\n.duel-root .chatb .dot{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:var(--pink);border:2px solid #121327}\n.duel-root .chat{position:absolute;right:12px;top:calc(var(--ch) + 190px + env(safe-area-inset-top,0px));width:min(340px,calc(100% - 24px));padding:10px;border-radius:16px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.18);box-shadow:0 12px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:8px;z-index:6}\n.duel-root .chat[hidden]{display:none}\n.duel-root .quick{display:flex;flex-wrap:wrap;gap:6px}\n.duel-root .quick button{height:34px;padding:0 11px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#1d1f2e;color:var(--text);font:800 16px/1 var(--f-game);letter-spacing:.3px}\n.duel-root .quick button:active{transform:scale(.95)}\n.duel-root .say{display:flex;gap:6px}\n.duel-root .say input{flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:#0b0c18;color:var(--text);font:500 16px/1 var(--f-ui);padding:0 10px}\n.duel-root .say button{height:40px;padding:0 14px;border-radius:10px;border:0;background:var(--gold);color:#121327;font:800 17px/1 var(--f-game)}\n.duel-root .ev.say span b{color:var(--gold)}\n.duel-root .ev.say.them span b{color:var(--pinkl)}\n.duel-root .feed{position:absolute;left:12px;top:calc(var(--ch) + 86px + env(safe-area-inset-top,0px));transition:top .25s ease;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:75%}\n.duel-root .ev{display:flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:999px;background:rgba(18,19,39,.72);border:1px solid rgba(46,50,58,.9);font-size:12px;white-space:nowrap;animation:evin .25s ease-out both;width:max-content}\n.duel-root .ev i{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:800 11px/1 var(--f-game);font-style:normal;color:#121327;flex:none}\n.duel-root .ev b{font:700 13px/1 var(--f-game)}\n@keyframes evin{from{opacity:0;transform:translateX(-12px)}}\n.duel-root .mute{position:absolute;right:12px;top:calc(var(--ch) + 86px + env(safe-area-inset-top,0px));transition:top .25s ease;width:44px;height:44px;border-radius:14px;background:var(--glass);border:2px solid var(--line);display:grid;place-items:center;padding:0}\n.duel-root .bottom{position:absolute;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:8px}\n.duel-root .pos{display:flex;align-items:stretch;gap:8px;border-radius:18px;padding:7px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.22);box-shadow:0 10px 26px rgba(0,0,0,.45);transition:border-color .2s,box-shadow .2s}\n.duel-root .pos small{display:block;font:700 11px/1 var(--f-game);letter-spacing:.7px;color:var(--muted)}\n.duel-root .stkc{width:66px;flex:none;border-radius:12px;background:#23262F;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0}\n.duel-root .stkc b{font:800 22px/1 var(--f-game);color:var(--champ)}\n.duel-root .pi small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.duel-root .pi{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px;padding-left:2px}\n.duel-root .pi b{font:800 26px/1 var(--f-game);font-variant-numeric:tabular-nums;white-space:nowrap}\n.duel-root .pnl{min-width:70px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0 8px;background:#23262F;color:var(--muted)}\n.duel-root .pnl b{font:800 21px/1 var(--f-game);font-variant-numeric:tabular-nums}\n.duel-root .pnl small{color:inherit;font:500 12px/1 var(--f-ui);letter-spacing:0}\n.duel-root .out{width:92px;flex:none;border-radius:12px;background:#F2F3F7;color:#121327;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0}\n.duel-root .out b{font:800 19px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .out small{color:#121327;opacity:.6;font:600 11px/1 var(--f-ui);letter-spacing:0}\n.duel-root .out:disabled{opacity:.25;cursor:default}\n.duel-root .pos.up{border-color:var(--green);box-shadow:0 0 0 3px rgba(95,240,160,.18),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pos.up .pnl{background:var(--green);color:#0d2a1b}\n.duel-root .pos.dn{border-color:var(--pink);box-shadow:0 0 0 3px rgba(240,48,127,.2),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pos.dn .pnl{background:var(--pink);color:#fff}\n.duel-root .row{display:flex;gap:8px}\n.duel-root .ctl{display:flex;gap:8px;align-items:stretch;height:92px}\n.duel-root .size{display:flex;align-items:center;gap:5px;padding:5px 5px 5px 12px;border-radius:14px;background:rgba(12,13,28,.88);border:1px solid rgba(255,255,255,.16)}\n.duel-root .size span{font:700 12px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);margin-right:auto;white-space:nowrap}\n.duel-root .size button{height:34px;min-width:46px;padding:0 8px;border-radius:10px;border:0;background:transparent;font:800 18px/1 var(--f-game);color:var(--text)}\n.duel-root .size button.on{background:var(--champ);color:#121327}\n.duel-root .size button .k{font:500 10px/1 var(--f-ui);opacity:.5;margin-left:3px}\n.duel-root .side{width:98px;flex:none;border-radius:20px;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;line-height:1;transition:transform .08s}\n.duel-root .side:active{transform:scale(.95)}\n.duel-root .side b{font:800 30px/1 var(--f-game)}\n.duel-root .side span{font:800 21px/1 var(--f-game);letter-spacing:1px}\n.duel-root .side small{font:600 12px/1 var(--f-ui);opacity:.8;margin-top:2px}\n.duel-root .side.boost{background:var(--gold);color:#121327;height:auto}\n.duel-root .side.dump{background:var(--pink);color:#fff;height:auto}\n.duel-root .pill{flex:1;min-width:0;border-radius:20px;background:rgba(12,13,28,.94);border:2px solid rgba(255,255,255,.22);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0 6px;box-shadow:0 10px 26px rgba(0,0,0,.45);transition:border-color .2s,box-shadow .2s,background .2s}\n.duel-root .pill small{font:700 11px/1 var(--f-game);letter-spacing:.8px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}\n.duel-root .pill .pv{display:flex;align-items:baseline;gap:6px}\n.duel-root .pill .pv b{font:800 32px/1 var(--f-game);font-variant-numeric:tabular-nums;white-space:nowrap}\n.duel-root .pill .pv em{font:800 22px/1 var(--f-game);font-style:normal;font-variant-numeric:tabular-nums;padding:3px 7px;border-radius:8px}\n.duel-root .pill.up .pv b,.duel-root .pill.dn .pv b{font-size:34px}\n.duel-root .pill .pv{gap:5px}\n@media (max-width:899px){.duel-root .ctl .side{width:84px}\n.duel-root .pill .pv em{font-size:17px;padding:2px 5px}\n.duel-root .pill{padding:0 4px}}\n@media (min-width:900px){.duel-root .pill.up .pv b,.duel-root .pill.dn .pv b{font-size:44px}}\n.duel-root .pill.up .pv b{color:var(--green);text-shadow:0 0 18px rgba(95,240,160,.35)}\n.duel-root .pill.dn .pv b{color:var(--pinkl);text-shadow:0 0 18px rgba(240,48,127,.35)}\n.duel-root .pill.up .pv em{background:rgba(95,240,160,.16)}\n.duel-root .pill.dn .pv em{background:rgba(240,48,127,.18)}\n.duel-root .pill:disabled{cursor:default}\n.duel-root .kh{display:none!important}\n@media (min-width:900px){.duel-root .kh{display:block!important;opacity:.55}}\n.duel-root .pill.up{border-color:var(--green);box-shadow:0 0 0 3px rgba(95,240,160,.18),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pill.up .pv em{color:var(--green)}\n.duel-root .pill.dn{border-color:var(--pink);box-shadow:0 0 0 3px rgba(240,48,127,.2),0 10px 26px rgba(0,0,0,.45)}\n.duel-root .pill.dn .pv em{color:var(--pinkl)}\n.duel-root .pill.up #bOutS,.duel-root .pill.dn #bOutS{color:var(--text)}\n.duel-root .pill:not(:disabled):active{transform:scale(.97)}\n.duel-root .btn{flex:1;border-radius:16px;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;transition:transform .08s,filter .15s}\n.duel-root .btn:active{transform:scale(.96)}\n.duel-root .btn:disabled{filter:grayscale(.8) brightness(.6);cursor:default}\n.duel-root .btn b{font:800 24px/1 var(--f-game);letter-spacing:1px}\n.duel-root .btn small{font:600 12px/1 var(--f-ui);margin-top:4px}\n.duel-root .boost{height:66px;background:var(--gold);color:#121327}\n.duel-root .dump{height:66px;background:var(--pink);color:#fff}\n.duel-root .alt{height:48px;background:rgba(18,19,39,.88);border:2px solid var(--line)}\n.duel-root .alt b{font-size:20px}\n.duel-root .kbd{opacity:.55;font-weight:500}\n.duel-root .ov{position:absolute;inset:0;background:rgba(6,7,14,.80);display:flex;align-items:flex-end;padding:0 14px calc(18px + env(safe-area-inset-bottom,0px))}\n.duel-root .card{width:100%;border-radius:22px;background:#15161B;border:1px solid #2E323A;padding:18px;display:flex;flex-direction:column;gap:12px}\n.duel-root .card h1{margin:0;font:800 42px/.95 var(--f-game)}\n.duel-root .tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}\n.duel-root .tile{border-radius:14px;padding:12px 8px;text-align:center;display:flex;flex-direction:column;gap:6px;align-items:center}\n.duel-root .tile b{font:800 20px/1 var(--f-game)}\n.duel-root .tile small{font-size:12px;line-height:1.25}\n.duel-root .lobby{gap:12px}\n.duel-root .lhead{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.duel-root .me-chip{text-align:right;line-height:1}\n.duel-root .me-chip b{display:block;font:800 22px/1 var(--f-game);color:var(--gold)}\n.duel-root .me-chip small{font:600 12px/1 var(--f-ui);color:var(--muted)}\n.duel-root .tabs{display:flex;background:#0e0f18;border:1px solid #2E323A;border-radius:14px;padding:4px;gap:4px}\n.duel-root .tab{flex:1;height:40px;border:0;border-radius:10px;background:transparent;color:var(--muted);font:800 18px/1 var(--f-game);letter-spacing:.8px}\n.duel-root .tab.on{background:#23262F;color:var(--text);box-shadow:inset 0 0 0 2px var(--gold)}\n.duel-root .online{display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:8px;font:600 13px/1 var(--f-ui);color:var(--muted)}\n.duel-root .online i{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}\n.duel-root [data-pane] .go{width:100%}\n.duel-root .join{display:flex;gap:6px;margin-top:8px}\n.duel-root .join input{flex:1;min-width:0;height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:#0b0c18;color:var(--text);font:700 18px/1 var(--f-game);letter-spacing:1px;padding:0 12px;text-transform:uppercase}\n.duel-root .join button{height:46px;padding:0 18px;border-radius:12px;border:2px solid var(--gold);background:transparent;color:var(--gold);font:800 18px/1 var(--f-game)}\n.duel-root .mm{align-items:stretch;text-align:center}\n.duel-root .mm h2{margin:0;font:800 32px/1 var(--f-game);letter-spacing:.5px}\n.duel-root .mm .sub{margin:0;color:var(--muted);font-size:14px}\n.duel-root .sec.wide{width:100%}\n.duel-root .sec.ghost{border-style:dashed!important;opacity:.75;font-size:15px!important}\n.duel-root .radar{position:relative;width:150px;height:150px;margin:6px auto 4px;border-radius:50%;background:radial-gradient(circle,rgba(242,193,78,.18),rgba(242,193,78,0) 70%);display:grid;place-items:center}\n.duel-root .radar i{position:absolute;inset:0;border-radius:50%;border:2px solid var(--gold);opacity:0;animation:ping 2.1s ease-out infinite}\n.duel-root .radar i:nth-child(2){animation-delay:.7s}\n.duel-root .radar i:nth-child(3){animation-delay:1.4s}\n.duel-root .radar b{font:800 34px/1 var(--f-game);font-variant-numeric:tabular-nums}\n@keyframes ping{0%{transform:scale(.35);opacity:.9}100%{transform:scale(1.05);opacity:0}}\n.duel-root .code{border-radius:16px;border:2px dashed var(--gold);padding:14px;background:rgba(242,193,78,.08);display:flex;flex-direction:column;gap:6px;align-items:center}\n.duel-root .code small{font:700 12px/1 var(--f-game);letter-spacing:1px;color:var(--muted)}\n.duel-root .code b{font:800 40px/1 var(--f-game);letter-spacing:2px;color:var(--gold)}\n.duel-root .code span{font:500 13px/1 var(--f-ui);color:var(--muted)}\n.duel-root .wait{display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;color:var(--muted)}\n.duel-root .spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:var(--gold);animation:rot 1s linear infinite}\n@keyframes rot{to{transform:rotate(360deg)}}\n.duel-root .vsrow{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px}\n.duel-root .vsx{font:800 30px/1 var(--f-game);color:var(--muted)}\n.duel-root .pc{border-radius:16px;padding:12px 8px;background:#1d1f27;border:2px solid #2E323A;display:flex;flex-direction:column;align-items:center;gap:5px}\n.duel-root .pc.me{border-color:var(--gold);background:rgba(242,193,78,.1)}\n.duel-root .pc:not(.me){border-color:var(--pink);background:rgba(240,48,127,.1)}\n.duel-root .pc .av{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;font:800 18px/1 var(--f-game);background:var(--gold);color:#121327}\n.duel-root .pc:not(.me) .av{background:var(--pink);color:#fff}\n.duel-root .pc b{font:800 19px/1 var(--f-game);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.duel-root .pc small{font:600 12px/1 var(--f-ui);color:var(--muted)}\n.duel-root .rdy{font:800 12px/1 var(--f-game);font-style:normal;letter-spacing:.8px;padding:4px 8px;border-radius:7px;background:#2a2d3a;color:var(--muted)}\n.duel-root .rdy.on{background:var(--green);color:#121327}\n.duel-root .opts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n.duel-root .opts span{font:700 12px/1 var(--f-game);letter-spacing:.6px;color:var(--muted);width:56px}\n.duel-root .opt{flex:1;height:40px;border-radius:12px;background:#23262F;border:2px solid #2E323A;font:800 17px/1 var(--f-game)}\n.duel-root .opt{height:48px!important;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}\n.duel-root .opt .ob{font:600 11px/1 var(--f-ui);color:var(--muted)}\n.duel-root .opt.on{border-color:var(--gold);background:rgba(242,193,78,.16)}\n.duel-root .go{height:58px;border-radius:16px;border:0;background:var(--gold);color:#121327;font:800 26px/1 var(--f-game);letter-spacing:1px}\n.duel-root .go:focus-visible,.duel-root .btn:focus-visible,.duel-root .opt:focus-visible{outline:3px solid #fff;outline-offset:2px}\n.duel-root .fine{margin:0;font-size:11px;color:rgba(215,217,228,.55);text-align:center}\n.duel-root .res h1{text-align:center;font-size:60px}\n.duel-root .margin{text-align:center;margin:-8px 0 2px}\n.duel-root .margin small{display:block;font:700 13px/1 var(--f-game);letter-spacing:1.5px;color:var(--muted)}\n.duel-root .margin b{display:block;font:800 64px/1 var(--f-game);font-variant-numeric:tabular-nums}\n.duel-root .res.win .margin b{color:var(--gold);text-shadow:0 0 28px rgba(242,193,78,.45)}\n.duel-root .res.win{border-color:var(--gold)!important;box-shadow:0 0 0 3px rgba(242,193,78,.25),0 20px 60px rgba(0,0,0,.6)}\n.duel-root .res.win h1{animation:pop .5s cubic-bezier(.3,1.6,.5,1)}\n.duel-root .ov.winbg{background:rgba(6,7,14,.5)}\n@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}\n.duel-root .sc.won{border-color:var(--gold);background:rgba(242,193,78,.16)}\n.duel-root .sc .crown{float:right;font:800 11px/1 var(--f-game);letter-spacing:1px;background:var(--gold);color:#121327;padding:3px 6px;border-radius:6px}\n.duel-root .res .sub{margin:-6px 0 0;text-align:center;color:var(--muted);font-size:14px}\n.duel-root .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.duel-root .sc{border-radius:16px;padding:12px;background:#1d1f27;border:1px solid #2E323A}\n.duel-root .sc.me{background:rgba(242,193,78,.12);border-color:var(--gold)}\n.duel-root .sc small{display:block;font-size:12px;color:var(--muted)}\n.duel-root .sc b{display:block;font:800 40px/1 var(--f-game);margin:2px 0}\n.duel-root .moments{border-radius:16px;padding:10px 12px;background:#1d1f27;border:1px solid #2E323A;display:flex;flex-direction:column;gap:6px;max-height:150px;overflow:auto}\n.duel-root .moments div{display:flex;justify-content:space-between;gap:8px;font-size:13px}\n.duel-root .moments div b{font:800 16px/1 var(--f-game);white-space:nowrap}\n.duel-root .moments .t{font:700 13px/1 var(--f-game);color:var(--muted);margin-right:6px}\n.duel-root .stats{display:flex;gap:8px}\n.duel-root .stats div{flex:1;border-radius:14px;padding:8px 10px;background:#1d1f27;border:1px solid #2E323A}\n.duel-root .stats small{display:block;font-size:11px;color:var(--muted)}\n.duel-root .stats b{font:800 20px/1 var(--f-game)}\n.duel-root .rrow{display:flex;gap:8px}\n.duel-root .rrow .go{flex:2}\n.duel-root .rrow .sec{flex:1;height:58px;border-radius:16px;background:#23262F;border:2px solid #2E323A;font:800 20px/1 var(--f-game)}\n.duel-root .toast{position:absolute;left:50%;top:calc(var(--ch) + 150px);transform:translateX(-50%);padding:9px 14px;border-radius:12px;background:rgba(18,19,39,.94);border:1px solid var(--line);font-size:13px;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none}\n.duel-root .toast.show{opacity:1}\n.duel-root .count{position:absolute;inset:0;display:grid;place-items:center;font:800 120px/1 var(--f-game);text-shadow:0 6px 30px rgba(0,0,0,.6);pointer-events:none}\n@media (min-width:900px) and (min-height:600px){.duel-root .app{width:100%;height:100%;border-radius:0;box-shadow:none;--ch:230px}\n.duel-root .app.big{--ch:360px}\n.duel-root .sb{left:50%;right:auto;width:720px;transform:translateX(-50%)}\n.duel-root .chart{left:24px;right:24px}\n.duel-root .feed{left:24px}\n.duel-root .mute{right:24px}\n.duel-root .bottom{left:50%;right:auto;width:560px;transform:translateX(-50%)}\n.duel-root .toast{top:calc(var(--ch) + 170px)}\n.duel-root .ov{align-items:center;justify-content:center}\n.duel-root .card{max-width:520px}}\n.duel-root .sb .r{text-align:right}\n.duel-root{position:fixed;inset:0;z-index:50;height:100%;overflow:hidden;color:var(--text);font-family:var(--f-ui);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}\n.duel-root .sec.signin{width:100%;margin-top:8px}.duel-root .lerr{margin:6px 0 0;text-align:center;color:var(--pinkl);font-size:13px;min-height:16px}\n.duel-root .practice{display:block;width:100%;margin-top:8px;background:transparent;border:0;color:var(--muted);font:600 13px/1 var(--f-ui);text-decoration:underline;text-underline-offset:3px}";
const HTML="<div class=\"stage\"><div class=\"app\" id=\"app\">\n<canvas id=\"sky\" aria-label=\"Your rocket and your rival's rocket racing. The higher rocket has made more profit.\"></canvas>\n\n<div class=\"sb\" aria-live=\"off\">\n  <div><span class=\"who\">YOU \u00b7 <span id=\"meN\">0</span> trades</span><b id=\"meP\">$0.00</b></div>\n  <div class=\"mid\" id=\"mid\"><b id=\"clock\">3:00</b><div class=\"lead\"><i id=\"leadI\"></i></div><small id=\"leadT\">EVEN</small></div>\n  <div class=\"r\"><span class=\"who r\" id=\"botLab\">@SOLWHALE \u00b7 <span id=\"botN\">0</span></span><b id=\"botP\">$0.00</b></div>\n</div>\n\n<button class=\"chart\" id=\"chart\" type=\"button\" aria-label=\"BTC tick chart, last 60 seconds. Tap to make it bigger.\"><canvas id=\"cc\"></canvas><span class=\"lab\" id=\"chLab\">BTC \u00b7 TICKS \u00b7 LAST 60S</span></button>\n<div class=\"feed\" id=\"feed\"></div>\n<button class=\"mute chatb\" id=\"chatB\" type=\"button\" aria-label=\"Chat\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#F2F3F7\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z\"/></svg><span class=\"dot\" id=\"chatDot\" hidden></span></button>\n<div class=\"chat\" id=\"chat\" hidden>\n  <div class=\"quick\" id=\"quick\"></div>\n  <form class=\"say\" id=\"sayF\" autocomplete=\"off\"><input id=\"sayI\" maxlength=\"60\" placeholder=\"Say something\" aria-label=\"Chat message\" enterkeyhint=\"send\"><button type=\"submit\">SEND</button></form>\n</div>\n<button class=\"mute\" id=\"mute\" type=\"button\" aria-label=\"Mute sound\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#F2F3F7\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 9v6h4l5 4V5L8 9z\"/><path id=\"mWave\" d=\"M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11\"/><path id=\"mX\" d=\"M16 9l5 6M21 9l-5 6\" hidden/></svg></button>\n\n<div class=\"bottom\">\n  <div class=\"size\" role=\"group\" aria-label=\"Trade size\">\n    <span>TRADE SIZE</span>\n    <button type=\"button\" data-i=\"0\">$1</button><button type=\"button\" data-i=\"1\">$2</button><button type=\"button\" data-i=\"2\" class=\"on\">$5</button><button type=\"button\" data-i=\"3\">$10</button><button type=\"button\" data-i=\"4\">ALL</button>\n  </div>\n  <div class=\"ctl\">\n    <button class=\"side boost\" id=\"bBoost\" type=\"button\" aria-label=\"Boost: go long\"><b>\u25b2</b><span id=\"bBoostS\">BOOST</span><small id=\"bBoostA\">$5</small><small class=\"kh\">SPACE</small></button>\n    <button class=\"pill\" id=\"bOut\" type=\"button\" disabled aria-live=\"polite\">\n      <small id=\"posLab\">DUEL FUEL</small>\n      <span class=\"pv\"><b id=\"posV\">$20.00</b><em id=\"pnlP\" hidden>+0.0%</em></span>\n      <small id=\"bOutS\">pick a side</small><small class=\"kh\">ENTER</small>\n    </button>\n    <button class=\"side dump\" id=\"bDump\" type=\"button\" aria-label=\"Dump: go short\"><b>\u25bc</b><span id=\"bDumpS\">DUMP</span><small id=\"bDumpA\">$5</small><small class=\"kh\">SHIFT</small></button>\n  </div>\n</div>\n\n<div class=\"toast\" id=\"toast\" role=\"status\"></div>\n<div class=\"count\" id=\"count\" hidden></div>\n\n<div class=\"ov\" id=\"intro\">\n  <div class=\"card lobby\">\n    <div class=\"lhead\"><h1>TRADING DUEL</h1><div class=\"me-chip\"><b id=\"lRat\">1,200</b><small id=\"lRec\">0-0</small></div></div>\n    <div class=\"tabs\" role=\"tablist\"><button class=\"tab on\" type=\"button\" data-tab=\"ranked\" role=\"tab\">RANKED</button><button class=\"tab\" type=\"button\" data-tab=\"friend\" role=\"tab\">FRIEND</button></div>\n    <div class=\"opts\" role=\"group\" aria-label=\"Tier\"><span>TIER</span>\n      <button class=\"opt\" type=\"button\" data-bot=\"rookie\">ROOKIE<small class=\"ob\">$20 fuel</small></button><button class=\"opt on\" type=\"button\" data-bot=\"pro\">PRO<small class=\"ob\">$50 fuel</small></button><button class=\"opt\" type=\"button\" data-bot=\"shark\">SHARK<small class=\"ob\">$150 fuel</small></button>\n    </div>\n    <div class=\"opts\" role=\"group\" aria-label=\"Length\"><span>LENGTH</span>\n      <button class=\"opt\" type=\"button\" data-len=\"60\">1 MIN</button><button class=\"opt on\" type=\"button\" data-len=\"180\">3 MIN</button>\n    </div>\n    <p class=\"lerr\" id=\"lErr\" role=\"status\"></p>\n    <div data-pane=\"ranked\">\n      <div class=\"online\"><i></i><span id=\"onl\">Live BTC \u00b7 same price for both pilots</span></div>\n      <button class=\"go\" type=\"button\" id=\"go\">FIND A MATCH</button>\n      <button class=\"practice\" type=\"button\" id=\"lPractice\">or warm up against a bot</button>\n      <p class=\"fine\" style=\"margin-top:8px\">Ranked: you're paired with someone near your rating. Wins move your rating.</p>\n    </div>\n    <div data-pane=\"friend\" hidden>\n      <button class=\"go\" type=\"button\" id=\"mkLink\">CREATE DUEL LINK</button>\n      <form class=\"join\" id=\"joinF\" autocomplete=\"off\"><input id=\"joinI\" maxlength=\"9\" placeholder=\"Have a code? DUEL-XXXX\" aria-label=\"Duel code\"><button type=\"submit\">JOIN</button></form>\n      <p class=\"fine\" style=\"margin-top:8px\">Friendly duels don't change your rating.</p>\n    </div>\n    <p class=\"fine\" id=\"lFine\">Live BTC price \u00b7 500\u00d7 \u00b7 fees count</p>\n  </div>\n</div>\n\n<div class=\"ov\" id=\"search\" hidden>\n  <div class=\"card mm\">\n    <div class=\"radar\"><i></i><i></i><i></i><b id=\"sT\">0:00</b></div>\n    <h2 id=\"sH\">FINDING A RIVAL</h2>\n    <p class=\"sub\" id=\"sSub\">PRO \u00b7 3 MIN \u00b7 near 1,200</p>\n    <button class=\"sec wide\" type=\"button\" id=\"sBot\" hidden>PLAY A BOT NOW</button>\n    <button class=\"sec wide\" type=\"button\" id=\"sCancel\">CANCEL</button>\n  </div>\n</div>\n\n<div class=\"ov\" id=\"invite\" hidden>\n  <div class=\"card mm\">\n    <h2>CHALLENGE A FRIEND</h2>\n    <p class=\"sub\" id=\"iSub\">PRO \u00b7 $50 fuel \u00b7 3 MIN</p>\n    <div class=\"code\"><small>DUEL CODE</small><b id=\"iCode\">DUEL-\u00b7\u00b7\u00b7\u00b7</b><span id=\"iLink\"></span></div>\n    <div class=\"rrow\"><button class=\"sec\" type=\"button\" id=\"iCopy\">COPY LINK</button><button class=\"sec\" type=\"button\" id=\"iX\">POST ON X</button></div>\n    <div class=\"wait\"><span class=\"spin\"></span><span id=\"iWait\">Waiting for your friend to open the link\u2026</span></div>\n    <button class=\"sec wide\" type=\"button\" id=\"iCancel\">CANCEL</button>\n  </div>\n</div>\n\n<div class=\"ov\" id=\"vs\" hidden>\n  <div class=\"card mm\">\n    <p class=\"sub\" id=\"vTag\">MATCH FOUND</p>\n    <div class=\"vsrow\">\n      <div class=\"pc me\"><div class=\"av\">YOU</div><b>you</b><small id=\"vMe\">1,200 \u00b7 0-0</small><em class=\"rdy\" id=\"vMeR\">NOT READY</em></div>\n      <div class=\"vsx\">VS</div>\n      <div class=\"pc\"><div class=\"av\" id=\"vAv\">SW</div><b id=\"vName\">@solwhale</b><small id=\"vThem\">1,214 \u00b7 41-37</small><em class=\"rdy\" id=\"vThemR\">NOT READY</em></div>\n    </div>\n    <p class=\"sub\" id=\"vSub\">PRO \u00b7 $50 fuel each \u00b7 3 MIN \u00b7 ranked</p>\n    <button class=\"go\" type=\"button\" id=\"vReady\">READY</button>\n    <p class=\"fine\" id=\"vAuto\">Starts when you're both ready \u00b7 auto-ready in <span id=\"vT\">10</span>s</p>\n    <button class=\"sec wide\" type=\"button\" id=\"vLeave\">LEAVE</button>\n  </div>\n</div>\n\n<div class=\"ov\" id=\"result\" hidden>\n  <div class=\"card res\">\n    <h1 id=\"rH\">YOU WIN</h1>\n    <div class=\"margin\" id=\"rMarg\"><small id=\"rMargL\">WON BY</small><b id=\"rMargV\">$0.00</b></div>\n    <p class=\"sub\" id=\"rSub\"></p>\n    <div class=\"two\">\n      <div class=\"sc me\"><small>you</small><b id=\"rMe\"></b><small id=\"rMeS\"></small></div>\n      <div class=\"sc\"><small id=\"rBotN\">@solwhale</small><b id=\"rBot\"></b><small id=\"rBotS\"></small></div>\n    </div>\n    <div class=\"moments\" id=\"rMom\"></div>\n    <div class=\"stats\"><div><small>Record</small><b id=\"rRec\">0-0</b></div><div><small>Rating</small><b id=\"rRat\">1,200</b></div><div><small>Win streak</small><b id=\"rStr\">0</b></div></div>\n    <div class=\"rrow\"><button class=\"sec\" type=\"button\" id=\"rBack\">LOBBY</button><button class=\"go\" type=\"button\" id=\"rAgain\">REMATCH</button></div>\n  </div>\n</div>\n</div></div>\n\n";
function mount(root,host){
  let dead=false; const offs=[];
  const on=(t,ev,f,o)=>{ t.addEventListener(ev,f,o); offs.push(()=>t.removeEventListener(ev,f,o)); };
  let st=document.getElementById("duel-css"); if(!st){ st=document.createElement("style"); st.id="duel-css"; st.textContent=CSS; document.head.appendChild(st); }
  root.classList.add("duel-root"); root.innerHTML=HTML;
  const cssv=n=>getComputedStyle(document.body).getPropertyValue(n).trim();
  const GF=cssv("--font-barlow-condensed")||"'Barlow Condensed'", GU=cssv("--font-geist")||"Geist";

  const A=host.assets;
  const $=id=>document.getElementById(id);
  const imgs={}; for(const k in A){const i=new Image(); i.src=A[k]; imgs[k]=i;}
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd=(a,b)=>a+Math.random()*(b-a);
  const gauss=()=>{let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
  const usd=(v,s)=>(s&&v>0?"+":"")+(v<0?"\u2212":"")+"$"+Math.abs(v).toFixed(2);
  const px=p=>p.toLocaleString("en-US",{minimumFractionDigits:1,maximumFractionDigits:1});
  const mmss=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");};

  /* ---------- rules ---------- */
  const LEV=500, FEE=0.00005 /* 0.5 bp a side: placeholder until Nova confirms duel fees */, LIQ=0.8 /* H-BOMB at 80% of the fuel in it lost */;
  let FUEL0=20;
  const TIERS={rookie:{fuel:20,sizes:[1,2,5,10,0]},pro:{fuel:50,sizes:[2,5,10,25,0]},shark:{fuel:150,sizes:[5,10,25,50,0]}};
  const BOTS={
    rookie:{name:"@moonboy",fuel:20,sizes:[1,2,5,10,0],react:[900,1700],cool:2600,thr:12,tp:.15,sl:-.4,noise:.35,stake:5,flip:.1},
    pro:{name:"@solwhale",fuel:50,sizes:[2,5,10,25,0],react:[450,900],cool:1500,thr:10,tp:.3,sl:-.25,noise:.1,stake:10,flip:.35},
    shark:{name:"@rektproof",fuel:150,sizes:[5,10,25,50,0],react:[250,520],cool:1100,thr:6,tp:.6,sl:-.2,noise:0,stake:30,flip:.6},
  };
  let botKey="pro", LEN=180000;
  try{botKey=localStorage.getItem("duel.tier")||botKey; LEN=+(localStorage.getItem("duel.len")||LEN); if(!BOTS[botKey]) botKey="pro"; if(LEN!==60000&&LEN!==180000) LEN=180000;}catch(e){}
  /* match: null, or {net:true, startAt, endAt, me:pid, opp:{pid,name}} for a live duel, or {net:false} for practice */
  let M=null, OFF=0; const now_=()=>Date.now()+OFF;

  /* ---------- state ---------- */
  let G=null;
  function newPlayer(name,me){return {name,me,fuel:FUEL0,pos:null,fees:0,trades:0,green:0,best:0,y:0,vy:0,flame:0,flameC:"255,200,120",sq:0,lastTrade:-1e9,next:0,moments:[]};}
  function newGame(){
    FUEL0=TIERS[botKey].fuel; SIZES=TIERS[botKey].sizes; if(!SIZES.includes(stake)) stake=SIZES[2]; paintSizes(); resizeK();
    const startAt=M&&M.startAt||Date.now()+3500, h=host.history();
    G={t:now_()-startAt,startAt,len:(M&&M.endAt?M.endAt-startAt:LEN),ot:false,over:false,price:h.length?h[h.length-1].p:0,ticks:[],marks:[],
       me:newPlayer("you",true),bot:newPlayer(M&&M.opp?M.opp.name:BOTS[botKey].name,false),cfg:BOTS[botKey],started:false};
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
  function vOpen(pl,side,stake,price){
    G.marks.push({t:G.t,p:price,me:pl.me,k:side>0?"b":"d"});
    fxTrade(pl,side,stake);
    feed(pl,side>0?"b":"d",pl.me?`you ${side>0?"boosted":"dumped"} <b>$${stake.toFixed(0)}</b>`:`${esc(pl.name)} ${side>0?"boosted":"dumped"} <b>$${stake.toFixed(0)}</b>`);
    pl.lastTrade=G.t;
  }
  function vClose(pl,side,net,price){
    if(!pl.me&&net>0&&Math.random()<.45&&!(M&&M.net)) setTimeout(()=>trick(pl,Math.random()<.5?"spin":"flip"),350);
    G.marks.push({t:G.t,p:price,me:pl.me,k:"x"});
    moment(pl,`${pl.me?"you":esc(pl.name)} closed ${side>0?"BOOST":"DUMP"}`,net);
    popAt(pl,usd(net,true),net>=0?"#5FF0A0":"#FF8FBD");
    feed(pl,net>=0?"g":"r",`${pl.me?"you":esc(pl.name)} banked <b>${usd(net,true)}</b>`);
    if(pl.me){ sfx(net>=0?"win":"lose"); buzz(net>=0?[12,30,12]:[30]); }
    pl.lastTrade=G.t;
  }
  function vBomb(pl,side,lost,price){
    G.marks.push({t:G.t,p:price,me:pl.me,k:"x"});
    moment(pl,`${pl.me?"you":esc(pl.name)} H-BOMB'd on a ${side>0?"BOOST":"DUMP"}`,-lost);
    fxBomb(pl); feed(pl,"r",`${pl.me?"you":esc(pl.name)} <b>H-BOMB'd</b>`);
    if(pl.me){sfx("bomb");buzz([60,40,90]);}
  }
  function open(pl,side,stake,why){
    stake=Math.min(stake,pl.fuel/(1+LEV*FEE));
    if(stake<1){ if(pl.me) toast("Out of duel fuel. Cash out to free some."); return false; }
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
  let stake=5, SIZES=[1,2,5,10,0];
  function paintSizes(){ document.querySelectorAll(".size button").forEach(b=>{const v=SIZES[+b.dataset.i]; b.textContent=v===0?"ALL":"$"+v; b.classList.toggle("on",v===stake);}); }
  function act(kind){
    if(!G||!G.started||G.over) return;
    const me=G.me;
    if(M&&M.net){
      if(kind==="x"&&!me.pos){toast("Nothing open.");return;}
      if(kind==="f"&&!me.pos){toast("Nothing open to flip.");return;}
      const action=kind==="b"?"boost":kind==="d"?"dump":kind==="f"?(me.pos.side>0?"dump":"boost"):"close";
      host.trade(action,kind==="f"?0:stake).then(r=>{ if(r&&r.error) toast(r.error); });
      return;
    }
    if(kind==="b"||kind==="d"){
      const side=kind==="b"?1:-1;
      if(me.pos&&me.pos.side!==side){ const c=me.pos.coll; close(me); open(me,side,c); }
      else open(me,side,stake===0?me.fuel:stake);
    } else if(kind==="f"){
      if(!me.pos){toast("Nothing open to flip.");return;}
      const side=-me.pos.side, c=me.pos.coll; close(me); open(me,side,c);
    } else if(kind==="x"){
      if(!me.pos){toast("Nothing open.");return;}
      close(me);
    }
    ui();
  }

  /* ---------- live duel: server events ---------- */
  function setBook(pl,b){ pl.fuel=b.fuel; pl.pos=b.pos?Object.assign({},b.pos):null; pl.fees=b.fees; pl.trades=b.trades; pl.green=b.green; pl.best=b.best; }
  function onEvent(ev){
    if(!G||!M||!M.net) return;
    const pl=ev.pid===M.me?G.me:G.bot;
    if(ev.type==="trade"||ev.type==="bomb"){
      for(const st of ev.steps){ if(st.kind==="open") vOpen(pl,st.side,st.usd,st.price); else if(st.kind==="close") vClose(pl,st.side,st.net,st.price); else vBomb(pl,st.side,st.lost,st.price); }
      setBook(pl,ev.book); pushPrice(ev.price,ev.ts); ui();
    } else if(ev.type==="chat"){ say(pl,ev.text); }
    else if(ev.type==="trick"){ if(!pl.me) trick(pl,ev.kind); }
    else if(ev.type==="overtime"){ G.ot=true; G.len=ev.endAt-G.startAt; toast("Overtime! 30 more seconds."); sfx("ot"); }
    else if(ev.type==="leave"){ if(!pl.me) toast(`${esc(G.bot.name)} left. Their trades still count.`); }
    else if(ev.type==="end"){ endNet(ev.result); }
  }
  /* ---------- the bot ---------- */
  function botThink(){
    const b=G.bot, c=G.cfg; if(G.t<b.next) return;
    b.next=G.t+rnd(c.react[0],c.react[1]);
    const p=G.price, past=priceAt(G.t-2500), m=p-past, mShort=p-priceAt(G.t-900);
    if(b.pos){
      const pnl=(pnlOf(b.pos,p)-b.pos.size*FEE)/b.pos.coll*5;
      const against=Math.sign(m)===-b.pos.side&&Math.abs(m)>c.thr;
      if(pnl>=c.tp*5||pnl<=c.sl*5||(against&&Math.random()<.7)||(G.len-G.t<4000&&pnl>0)){
        const side=b.pos.side; close(b);
        if(against&&Math.random()<c.flip&&G.t-b.lastTrade>=0) open(b,-side,c.stake);
      }
      return;
    }
    if(G.t-b.lastTrade<c.cool) return;
    if(Math.random()<c.noise){ open(b,Math.random()<.5?1:-1,c.stake); return; }
    if(Math.abs(m)>c.thr&&Math.sign(mShort)!==-Math.sign(m)) open(b,Math.sign(m),Math.abs(m)>c.thr*1.8?c.stake*2:c.stake);
  }
  function priceAt(t){ for(let i=G.ticks.length-1;i>=0;i--) if(G.ticks[i].t<=t) return G.ticks[i].p; return G.ticks[0].p; }

  /* ---------- loop ---------- */
  let last=0, cdUntil=0;
  function frame(now){
    const dt=Math.min(.05,(now-(last||now))/1000); last=now;
    if(G&&G.started&&!G.over){
      G.t=now_()-G.startAt;
      if(!(M&&M.net)){
      for(const pl of [G.me,G.bot]) if(pl.pos&&pnlOf(pl.pos,G.price)<=-LIQ*pl.pos.coll) liquidate(pl);
      botThink();
      }
      if(!(M&&M.net)&&G.t>=G.len){
        const d=profitOf(G.me)-profitOf(G.bot);
        if(!G.ot&&Math.abs(d)<0.25*FUEL0/20){ G.ot=true; G.len+=30000; toast("Overtime! 30 more seconds."); sfx("ot"); }
        else end();
      }
      ui();
    }
    if(G&&!G.started) G.t=now_()-G.startAt;
    drawSky(dt,now); if(!G||!G.chartAt||now-G.chartAt>60){ drawChart(); if(G)G.chartAt=now; }
    if(!dead) requestAnimationFrame(frame);
  }

  /* ---------- UI ---------- */
  function ui(){
    const me=G.me,b=G.bot, pm=profitOf(me), pb=profitOf(b), d=pm-pb;
    $("meP").textContent=usd(pm,true); $("meP").style.color=pm>0?"var(--green)":pm<0?"var(--pinkl)":"var(--text)";
    $("botP").textContent=usd(pb,true); $("botP").style.color=pb>0?"var(--green)":pb<0?"var(--pinkl)":"var(--text)";
    $("meN").textContent=me.trades; $("botN").textContent=b.trades;
    $("clock").textContent=mmss(Math.min(G.len,G.len-G.t)); $("mid").classList.toggle("ot",G.ot);
    const w=Math.min(50,Math.abs(d)*25); const li=$("leadI");
    li.style.left=d>=0?"50%":(50-w)+"%"; li.style.width=w+"%"; li.style.background=d>=0?"var(--green)":"var(--pink)";
    $("leadT").textContent=Math.abs(d)<0.005?"EVEN":(d>0?"UP ":"DOWN ")+"$"+Math.abs(d).toFixed(2);
    $("leadT").style.color=Math.abs(d)<0.005?"var(--muted)":d>0?"var(--green)":"var(--pinkl)";
    const pos=me.pos, el=$("bOut");
    if(pos){
      const pnl=pnlOf(pos,G.price), pct=pnl/pos.coll*100, back=Math.max(0,pos.coll+pnl-pos.size*FEE);
      $("posLab").textContent=`${pos.side>0?"BOOST \u25b2":"DUMP \u25bc"} ${LEV}\u00d7 \u00b7 $${pos.coll.toFixed(0)} IN`;
      $("posV").textContent=usd(pnl,true); const e=$("pnlP"); e.hidden=false; e.textContent=(pct>=0?"+":"\u2212")+Math.abs(pct).toFixed(1)+"%";
      $("bOutS").textContent=`TAP TO CASH OUT ${usd(back)}`;
      el.classList.toggle("up",pnl>=0); el.classList.toggle("dn",pnl<0); el.disabled=false;
    } else {
      $("posLab").textContent="DUEL FUEL"; $("posV").textContent=usd(me.fuel); $("pnlP").hidden=true;
      $("bOutS").textContent="pick a side"; el.classList.remove("up","dn"); el.disabled=true;
    }
    const lb=pos&&pos.side<0, ld=pos&&pos.side>0;
    const amt=stake===0?"all":"$"+stake;
    $("bBoostS").textContent=lb?"FLIP":"BOOST"; $("bBoostA").textContent=lb?"to long":pos?"add "+amt:amt;
    $("bDumpS").textContent=ld?"FLIP":"DUMP"; $("bDumpA").textContent=ld?"to short":pos?"add "+amt:amt;
    paintSizes();
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
  function say(pl,txt){
    txt=txt.trim().slice(0,60); if(!txt||!G) return;
    pl.say={txt,until:performance.now()+3200};
    feed(pl,"c",`<b>${pl.me?"you":esc(pl.name)}</b> ${esc(txt)}`);
    if(!pl.me&&$("chat").hidden) $("chatDot").hidden=false;
    sfx("tick");
  }
  let botSayT=0; function botSay(txt,delay){ clearTimeout(botSayT); botSayT=setTimeout(()=>{ if(G&&!G.over||txt==="gg") say(G.bot,txt); },delay||rnd(900,2000)); }
  function meSay(txt){
    if(M&&M.net){ host.chat(txt).then(r=>{ if(r&&r.error) toast(r.error); }); return; }
    say(G.me,txt);
    const t=txt.toLowerCase(), lead=profitOf(G.me)-profitOf(G.bot);
    if(Math.random()<.65) botSay(/gg|wp/.test(t)?pick(["gg","gg wp"]):/rekt|lol|\ud83d\ude02/.test(t)?(lead>0?pick(["it's not over","watch this"]):pick(["you're the one down","check the board"])):/catch|\ud83d\ude80/.test(t)?pick(["on my way","see you up there","\ud83d\ude80\ud83d\ude80"]):pick(["\ud83d\udc40","focus up","less talking more trading","ok"]));
  }
  let toastT=0; function toast(m){const t=$("toast");t.textContent=m;t.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove("show"),1800);}

  /* ---------- chart ---------- */
  const cc=$("cc"), cx=cc.getContext("2d");
  function drawChart(){
    if(!G) return;
    const w=cc.clientWidth,h=cc.clientHeight; if(!w) return; const d=Math.min(2,devicePixelRatio||1);
    if(cc.width!==Math.round(w*d)||cc.height!==Math.round(h*d)){cc.width=Math.round(w*d);cc.height=Math.round(h*d);}
    cx.setTransform(d,0,0,d,0,0); cx.clearRect(0,0,w,h);
    const now=G.t, from=now-60000; const T0=G.ticks.findIndex(k=>k.t>=from); const pts=G.ticks.slice(Math.max(0,T0-1));
    let lo=Infinity,hi=-Infinity; pts.forEach(k=>{lo=Math.min(lo,k.p);hi=Math.max(hi,k.p);});
    for(const pl of [G.me,G.bot]) if(pl.pos){lo=Math.min(lo,pl.pos.entry);hi=Math.max(hi,pl.pos.entry);}
    const pad=Math.max(4,(hi-lo)*.15); lo-=pad; hi+=pad;
    const L=8,Rr=66,T=24,B=8, X=t=>L+Math.max(0,(t-from))/60000*(w-L-Rr), Y=p=>T+(1-(p-lo)/(hi-lo))*(h-T-B);
    const first=pts[0].p, lastp=G.price, up=lastp>=first, col=up?"95,240,160":"240,48,127";
    // grid
    cx.font="500 10px "+GU+",sans-serif"; cx.fillStyle="rgba(215,217,228,.6)"; cx.textAlign="left"; cx.textBaseline="middle";
    const step=niceStep((hi-lo)/3);
    for(let v=Math.ceil(lo/step)*step; v<hi; v+=step){const y=Y(v); cx.strokeStyle="rgba(255,255,255,.07)"; cx.setLineDash([3,5]); cx.beginPath(); cx.moveTo(L,y); cx.lineTo(w-Rr,y); cx.stroke(); cx.setLineDash([]); cx.fillText(Math.round(v).toLocaleString("en-US"),w-Rr+8,y);}
    // stepped line + area
    cx.beginPath(); let py=null;
    pts.forEach((k,i)=>{const x=X(k.t),y=Y(k.p); if(!i){cx.moveTo(x,y);} else {cx.lineTo(x,py); cx.lineTo(x,y);} py=y;});
    const lx=X(now), ly=Y(lastp); cx.lineTo(lx,ly);
    cx.lineWidth=2.5; cx.strokeStyle=`rgb(${col})`; cx.lineJoin="miter"; cx.stroke();
    cx.lineTo(lx,h); cx.lineTo(L,h); cx.closePath();
    const g=cx.createLinearGradient(0,T,0,h); g.addColorStop(0,`rgba(${col},.30)`); g.addColorStop(1,`rgba(${col},0)`); cx.fillStyle=g; cx.fill();
    // entry lines
    const entry=(pl,color,label,below)=>{ if(!pl.pos) return; const y=Y(pl.pos.entry);
      cx.setLineDash(pl.me?[5,4]:[3,4]); cx.strokeStyle=color; cx.lineWidth=pl.me?1.5:1; cx.beginPath(); cx.moveTo(L,y); cx.lineTo(w-Rr,y); cx.stroke(); cx.setLineDash([]);
      cx.font="700 11px "+GF+",sans-serif"; cx.fillStyle=color; cx.textAlign=pl.me?"left":"right"; cx.textBaseline=below?"top":"bottom"; cx.fillText(label,pl.me?L+2:w-Rr-4,below?y+2:y-2); };
    entry(G.bot,"rgba(185,188,203,.75)",`${G.bot.name.toUpperCase()} ${G.bot.pos&&G.bot.pos.side>0?"BOOSTED":"DUMPED"}`,true);
    entry(G.me,"rgba(242,193,78,.95)",`YOU ${G.me.pos&&G.me.pos.side>0?"BOOSTED":"DUMPED"}`,false);
    // trade dots
    // yours are round, the rival's are diamonds; both the same size so you can read their timing
    G.marks.forEach(k=>{ if(k.t<from) return; const x=X(k.t),y=Y(k.p); cx.beginPath();
      if(k.me) cx.arc(x,y,5.5,0,Math.PI*2); else { const r=6.5; cx.moveTo(x,y-r); cx.lineTo(x+r,y); cx.lineTo(x,y+r); cx.lineTo(x-r,y); cx.closePath(); }
      cx.fillStyle=k.k==="x"?"#FFFFFF":k.k==="b"?(k.me?"#F2C14E":"#5FF0A0"):(k.me?"#F0307F":"#FF8FBD"); cx.fill();
      cx.lineWidth=2; cx.strokeStyle="#121327"; cx.stroke(); });
    // live dot + price tag
    cx.fillStyle=`rgb(${col})`; cx.beginPath(); cx.arc(lx,ly,4.5,0,Math.PI*2); cx.fill();
    const tag=px(lastp); cx.font="800 15px "+GF+",sans-serif";
    const tw=Rr-6, ty=Math.max(T-4,Math.min(h-B-20,ly-10)); cx.fillStyle=`rgb(${col})`; cx.beginPath(); cx.roundRect?cx.roundRect(w-Rr+3,ty,tw,20,6):cx.rect(w-Rr+3,ty,tw,20); cx.fill();
    cx.fillStyle=up?"#0d2a1b":"#fff"; cx.textAlign="center"; cx.textBaseline="middle"; cx.fillText(tag,w-Rr+3+tw/2,ty+10.5);
    const ch=(lastp-first); $("chLab").textContent=`BTC \u00b7 TICKS \u00b7 60S  ${ch>=0?"+":"\u2212"}$${Math.abs(ch).toFixed(1)}`;
  }
  function niceStep(r){const p=Math.pow(10,Math.floor(Math.log10(r)));const n=r/p;return (n<1.5?1:n<3.5?2:n<7.5?5:10)*p;}
  function toggleChart(){$("app").classList.toggle("big"); $("chart").setAttribute("aria-label",$("app").classList.contains("big")?"BTC tick chart. Tap to make it smaller.":"BTC tick chart, last 60 seconds. Tap to make it bigger.");}
  $("chart").addEventListener("click",toggleChart);

  /* ---------- sky: the rocket race ----------
   * Altitude = profit. Each $1 of profit is K px of climb. The camera follows the pair, so a rocket that is winning
   * keeps climbing past altitude marks and through the sky layers, and a losing one drops back toward the pad.
   * If the gap gets too big for the screen, the camera zooms out. */
  const sky=$("sky"), sx=sky.getContext("2d"); let SW=0,SH=0,DPR=1;
  const FX={parts:[],pops:[],rings:[],shake:0,flash:0,flashC:"255,255,255"};
  let stars=[], cam={y:0,vy:0,z:1}, K=70;
  const SKY_ORDER=["sky0","sky1","sky2","sky3","sky4"];
  function resize(){
    DPR=Math.min(2,devicePixelRatio||1); SW=sky.clientWidth; SH=sky.clientHeight; sky.width=Math.round(SW*DPR); sky.height=Math.round(SH*DPR);
    stars=Array.from({length:70},()=>({x:Math.random()*SW,y:Math.random()*SH,z:rnd(.25,1)}));
    resizeK();
  }
  on(window,"resize",resize);
  function resizeK(){ K=RH()*2; }   // $1 of lead = two rocket lengths of sky
  function RH(){ return SW>=900?150:116; }
  function lane0(pl){ const wide=SW>=900; return pl.me?SW*(wide?.40:.30):SW*(wide?.60:.70); }
  function lane(pl){ return lane0(pl)+(pl.sxo||0); }
  /* steering: drag the sky (phone) or hold A/D (desktop). Tricks: swipe up = spin, double-tap = flip, Q/E on desktop. */
  function steerTo(pl,off){ const b=lane0(pl); pl.sxt=Math.max(34-b,Math.min(SW-34-b,off)); }
  const TRICKS={spin:{dur:.7,txt:"SPIN!",c:"#8FE3FF"},flip:{dur:.85,txt:"FLIP!",c:"#F2C14E"}};
  function trick(pl,kind){
    if(!G||!G.started||G.over||!pl) return; if(pl.trick&&pl.trick.t<pl.trick.dur) return;
    pl.trick={kind,t:0,dur:TRICKS[kind].dur};
    FX.pops.push({txt:TRICKS[kind].txt,c:TRICKS[kind].c,x:lane(pl),y:pl.y-RH()*.75,age:0,max:1.1,size:pl.me?28:22});
    FX.rings.push({x:lane(pl),y:pl.y,r:20,vr:420,life:.5,max:.5,w:5,col:kind==="spin"?"143,227,255":"242,193,78"});
    for(let i=0;i<24;i++){const a=rnd(0,Math.PI*2),sp=rnd(120,320); part({x:lane(pl),y:pl.y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.4,.8),size:rnd(2,3.5),col:kind==="spin"?"143,227,255":"255,214,120"});}
    if(pl.me){ sfx("trick"); buzz(12); if(M&&M.net) host.trick(kind); } else feed(pl,"t",`${pl.name} did a <b>${kind}</b> on you`);
  }
  let drag=null, lastTap=0;
  function skyDown(e){ if(!G||!G.started||G.over) return; drag={x:e.clientX,y:e.clientY,t:performance.now(),off:G.me.sxt||0,offY:G.me.syt||0,moved:false}; try{sky.setPointerCapture(e.pointerId);}catch(_){} }
  function skyMove(e){ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(Math.abs(dx)>8) drag.moved=true; steerTo(G.me,drag.off+dx*1.15); if(performance.now()-drag.t>200) G.me.syt=Math.max(-70,Math.min(70,(drag.offY||0)+dy*.6)); }
  function skyUp(e){ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y, dt=performance.now()-drag.t, now=performance.now();
    if(dy<-55&&Math.abs(dy)>Math.abs(dx)*1.3&&dt<450) trick(G.me,"spin");
    else if(Math.abs(dx)<10&&Math.abs(dy)<10&&dt<250){ if(now-lastTap<320){trick(G.me,"flip"); lastTap=0;} else lastTap=now; }
    drag=null; }

  function band(){
    const f=$("feed"), top=f.offsetTop+64+RH()*.5+34, bot=document.querySelector(".bottom").offsetTop-RH()*.55-10;
    return [top,Math.max(top+60,bot)];
  }
  const alt=pl=>profitOf(pl);                       // $ of altitude
  const worldY=pl=>-alt(pl)*K;                       // world px, up is negative
  function screenY(wy){ const [top,bot]=band(); return (top+bot)/2+(wy-cam.y)*cam.z; }
  function part(o){ if(FX.parts.length>280) return; const p=Object.assign({life:1,size:4,g:0,drag:1.5,add:true},o); p.max=p.life; FX.parts.push(p); }
  function popAt(pl,txt,c){ FX.pops.push({txt,c,x:lane(pl),y:pl.y-RH()*.7,age:0,max:1.4,size:pl.me?30:22}); }
  function fxTrade(pl,side,stake){
    const k=Math.min(1,stake/20), m=pl.me?1:.6;
    pl.flame=Math.min(2.2,pl.flame+(.7+k)*m); pl.kick-= (220+k*260)*m; pl.sq=-.22*m; pl.vr+=(Math.random()-.5)*.8*m;
    const x=lane(pl), y=pl.y+RH()*.45, c1=side>0?"255,214,120":"255,143,189", c2=side>0?"255,160,70":"240,48,127";
    for(let i=0;i<Math.round((24+k*46)*m);i++){const a=Math.PI/2+rnd(-.6,.6), sp=rnd(220,620); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.35,.85),size:rnd(2,4.8),col:Math.random()<.5?c1:c2});}
    for(let i=0;i<Math.round(10*m);i++) part({x:x+rnd(-10,10),y:y+rnd(0,20),vx:rnd(-90,90),vy:rnd(60,200),life:rnd(.8,1.5),size:rnd(14,26),col:"235,232,245",kind:"smoke",add:false});
    FX.rings.push({x,y:y+6,r:8,vr:380+k*320,life:.45,max:.45,w:6+k*4,col:c1});
    if(pl.me){ FX.flash=Math.max(FX.flash,.12+k*.15); FX.flashC=side>0?"255,206,100":"240,48,127"; sfx(side>0?"boost":"dump"); buzz(side>0?18:[10,20,10]); }
  }
  function fxBomb(pl){
    const x=lane(pl), y=pl.y;
    part({x,y,vx:0,vy:0,life:.5,size:150,kind:"ball",drag:0});
    for(let i=0;i<90;i++){const a=rnd(0,Math.PI*2), sp=rnd(140,700); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(.4,1),size:rnd(2.5,6),col:Math.random()<.4?"255,240,200":"255,120,60"});}
    for(let i=0;i<16;i++){const a=rnd(0,Math.PI*2), sp=rnd(60,240); part({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:rnd(1,1.8),size:rnd(18,40),col:"70,62,80",kind:"smoke",add:false});}
    FX.rings.push({x,y,r:16,vr:900,life:.55,max:.55,w:14,col:"255,240,220"}); FX.rings.push({x,y,r:6,vr:520,life:.7,max:.7,w:6,col:"240,48,127"});
    FX.pops.push({txt:"H-BOMB",c:"#F0307F",x,y:y-80,age:0,max:1.6,size:34});
    if(pl.me&&!reduce){FX.shake=22; FX.flash=.5; FX.flashC="255,245,235";}
    pl.kick+=500; pl.sq=.25; pl.vr+=(Math.random()<.5?-1:1)*3;
  }
  function rr(x,y,w,h,r){sx.beginPath(); sx.roundRect?sx.roundRect(x,y,w,h,r):sx.rect(x,y,w,h);}
  function drawBackdrop(camAlt){
    // sky layers by altitude: losing drops you toward the pad, winning climbs to space
    const f=Math.max(0,Math.min(SKY_ORDER.length-1,(camAlt+3)/2.5)), i0=Math.floor(f), t=f-i0;
    const draw=(k,a)=>{const im=imgs[k]; if(!im||!im.complete||a<=0) return; const s=Math.max(SW/im.width,SH/im.height)*1.12;
      const par=((camAlt*K*.08)%60); sx.globalAlpha=a; sx.drawImage(im,(SW-im.width*s)/2,(SH-im.height*s)/2+par*0,im.width*s,im.height*s); sx.globalAlpha=1;};
    sx.fillStyle="#121327"; sx.fillRect(0,0,SW,SH);
    draw(SKY_ORDER[i0],1); if(t>0&&i0+1<SKY_ORDER.length) draw(SKY_ORDER[i0+1],t);
    sx.fillStyle="rgba(11,10,22,.28)"; sx.fillRect(0,0,SW,SH);
  }
  function drawRuler(){
    // altitude marks: a line every step dollars, labelled; EVEN is the start line
    const [top,bot]=band(); const pxPer=K*cam.z; let step=[1,2,5,10,25,50,100].find(v=>v*pxPer>70)||100;
    const lo=(cam.y-(SH)/cam.z)/K, hi=(cam.y+(SH)/cam.z)/K;     // world y in $ (negated altitude)
    sx.font="700 11px "+GF+",sans-serif"; sx.textAlign="right"; sx.textBaseline="bottom";
    for(let v=Math.floor(-hi/step)*step; v<=Math.ceil(-lo/step)*step; v+=step){
      const y=screenY(-v*K); if(y<top-RH()*.5-20||y>SH) continue;
      const even=v===0; sx.strokeStyle=even?"rgba(255,255,255,.45)":"rgba(255,255,255,.12)"; sx.lineWidth=even?1.5:1; sx.setLineDash(even?[6,5]:[3,7]);
      sx.beginPath(); sx.moveTo(0,y); sx.lineTo(SW,y); sx.stroke(); sx.setLineDash([]);
      sx.fillStyle=even?"rgba(242,243,247,.85)":v>0?"rgba(95,240,160,.7)":"rgba(255,143,189,.7)";
      sx.fillText(even?"START":(v>0?"+$":"\u2212$")+Math.abs(v),SW-12,y-3);
    }
  }
  function drawGap(){
    if(!G||!G.started) return; const a=G.me, b=G.bot, d=profitOf(a)-profitOf(b); if(Math.abs(d)<0.05) return;
    const top=Math.min(a.y,b.y), bot=Math.max(a.y,b.y); if(bot-top<40) return;
    const x=Math.max(30,Math.min(lane(a),lane(b))-74), col=d>0?"95,240,160":"255,143,189";
    sx.strokeStyle=`rgba(${col},.55)`; sx.lineWidth=2; sx.setLineDash([4,5]);
    sx.beginPath(); sx.moveTo(x,top); sx.lineTo(x,bot); sx.stroke(); sx.setLineDash([]);
    sx.beginPath(); sx.moveTo(x-6,top); sx.lineTo(x+6,top); sx.moveTo(x-6,bot); sx.lineTo(x+6,bot); sx.stroke();
    const t=(d>0?"+":"\u2212")+"$"+Math.abs(d).toFixed(2); sx.font="800 16px "+GF+",sans-serif";
    const w=sx.measureText(t).width+12, my=(top+bot)/2; sx.fillStyle=`rgba(${col},.95)`; rr(x-w/2,my-11,w,22,8); sx.fill();
    sx.fillStyle="#121327"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(t,x,my+1);
  }
  function drawRocket(pl,now,leader){
    let x=lane(pl)+pl.dx, y=pl.y, img=imgs.rocket, h=(pl.me?RH():RH()*.82), w=h*221/609;
    const lean=Math.max(-.22,Math.min(.22,pl.rot));
    // flame grows while climbing, sputters while falling
    const thrust=Math.max(.25,Math.min(2.4,.6+pl.flame*.6-pl.wvy*.004)), fl=thrust+Math.sin(now/40+(pl.me?0:2))*.08;
    const c=pl.me?"255,200,80":"255,95,170";   // team colours: gold = you, pink = rival
    const tr=pl.trick&&pl.trick.t<pl.trick.dur?pl.trick:null, tp=tr?tr.t/tr.dur:0, ease=tp<.5?2*tp*tp:1-Math.pow(-2*tp+2,2)/2;
    sx.save(); sx.translate(x,y); sx.rotate(lean+Math.max(-.35,Math.min(.35,pl.steerLean||0))+(tr&&tr.kind==="flip"?ease*Math.PI*2:0));
    if(tr&&tr.kind==="spin"){ const c=Math.cos(ease*Math.PI*4); sx.scale(Math.abs(c)<.08?.08*Math.sign(c||1):c,1); }
    sx.globalCompositeOperation="lighter";
    const fy=h*.47; const g=sx.createRadialGradient(0,fy,2,0,fy+30*fl,72*fl); g.addColorStop(0,"rgba(255,250,235,.95)"); g.addColorStop(.25,`rgba(${c},.85)`); g.addColorStop(1,`rgba(${c},0)`);
    sx.fillStyle=g; sx.beginPath(); sx.ellipse(0,fy+36*fl,15*fl+5,60*fl+8,0,0,Math.PI*2); sx.fill();
    sx.globalCompositeOperation="source-over";
    sx.scale(1-pl.sq*.3,1+pl.sq);
    if(img.complete) sx.drawImage(img,-w/2,-h/2,w,h);
    sx.restore();
    // tags
    const pr=profitOf(pl), txt=(pl.me?"YOU ":pl.name+" ")+usd(pr,true);
    sx.font=`800 ${pl.me?15:13}px ${GF},sans-serif`; const tw=sx.measureText(txt).width+14; const X0=x; x=Math.max(tw/2+6,Math.min(SW-tw/2-6,X0));
    let ty=y-h/2-30; sx.fillStyle="rgba(11,10,22,.86)"; rr(x-tw/2,ty,tw,22,7); sx.fill();
    sx.fillStyle=pr>0?"#5FF0A0":pr<0?"#FF8FBD":"#F2F3F7"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(txt,x,ty+11.5);
    if(leader){ sx.font="800 12px "+GF+",sans-serif"; const lw=sx.measureText("LEADING").width+12; sx.fillStyle="#F2C14E"; rr(x-lw/2,ty-20,lw,17,6); sx.fill(); sx.fillStyle="#121327"; sx.fillText("LEADING",x,ty-11); }
    if(pl.say&&now<pl.say.until){ const a=Math.min(1,(pl.say.until-now)/300); sx.globalAlpha=a; sx.font="700 15px "+GU+",system-ui,sans-serif"; const sw=Math.min(220,sx.measureText(pl.say.txt).width+20), by=ty-(leader?50:30);
      const bx=Math.max(sw/2+6,Math.min(SW-sw/2-6,x)); sx.fillStyle=pl.me?"#F2C14E":"#F0307F"; rr(bx-sw/2,by-26,sw,28,12); sx.fill();
      sx.beginPath(); sx.moveTo(bx-6,by+1); sx.lineTo(bx+6,by+1); sx.lineTo(bx,by+8); sx.fill();
      sx.fillStyle=pl.me?"#121327":"#fff"; sx.textAlign="center"; sx.textBaseline="middle"; sx.fillText(pl.say.txt,bx,by-12,sw-14); sx.globalAlpha=1; }
    if(pl.pos){ const t2=`${pl.pos.side>0?"BOOST \u25b2":"DUMP \u25bc"} ${LEV}\u00d7`; sx.font="700 12px "+GF+",sans-serif"; const w2=sx.measureText(t2).width+12;
      sx.fillStyle=pl.pos.side>0?"rgba(242,193,78,.92)":"rgba(240,48,127,.92)"; rr(x-w2/2,ty+25,w2,17,6); sx.fill(); sx.fillStyle=pl.pos.side>0?"#121327":"#fff"; sx.fillText(t2,x,ty+34); }
  }
  function drawSky(dt,now){
    if(!SW) resize();
    sx.setTransform(DPR,0,0,DPR,0,0);
    const sh=FX.shake; FX.shake=Math.max(0,FX.shake-dt*60);
    let camDy=0;
    if(G){
      for(const pl of [G.me,G.bot]){ if(pl.wy==null){pl.wy=0;pl.wvy=0;pl.kick=0;pl.dx=0;pl.rot=0;pl.vr=0;} }
      // world positions: spring toward altitude, plus kicks from trades
      for(const pl of [G.me,G.bot]){
        const tgt=worldY(pl); pl.wvy+=((tgt-pl.wy)*14-pl.wvy*5.5)*dt + pl.kick*dt*6; pl.kick*=Math.max(0,1-dt*6); pl.wy+=pl.wvy*dt;
        pl.rot+= (Math.max(-.2,Math.min(.2,-pl.wvy*.0006*(pl.me?1:-1))) - pl.rot)*Math.min(1,dt*4) + pl.vr*dt; pl.vr*=Math.max(0,1-dt*3);
        if(pl.me){ if(keys.l) steerTo(pl,(pl.sxt||0)-460*dt); if(keys.r) steerTo(pl,(pl.sxt||0)+460*dt);
          if(keys.u) pl.syt=Math.max(-70,(pl.syt||0)-300*dt); if(keys.dn) pl.syt=Math.min(70,(pl.syt||0)+300*dt);
          if(!keys.u&&!keys.dn&&!drag) pl.syt=(pl.syt||0)*Math.max(0,1-dt*1.2); }
        else { // the bot drifts around and keeps out of your way
          if(!pl.wander||now>pl.wander){ pl.wander=now+rnd(1200,3200); steerTo(pl,rnd(-SW*.12,SW*.12)); }
          const gap=lane(pl)-lane(G.me); if(Math.abs(gap)<90){ const roomR=SW-lane(G.me), roomL=lane(G.me); const dir=(gap>=0?(roomR>110?1:-1):(roomL>110?-1:1)); steerTo(pl,(pl.sxt||0)+dir*320*dt); }
        }
        pl.syo=(pl.syo||0)+((pl.syt||0)-(pl.syo||0))*Math.min(1,dt*8);
        const so=pl.sxo||0, st=pl.sxt||0, sv=(st-so)*Math.min(1,dt*8); pl.sxo=so+sv; pl.steerLean=(pl.steerLean||0)+((sv/Math.max(dt,1e-3))*.0009-(pl.steerLean||0))*Math.min(1,dt*6);
        if(pl.trick&&pl.trick.t<pl.trick.dur) pl.trick.t+=dt;
        pl.dx=Math.sin(now/900+(pl.me?0:2.1))*6; pl.flame=Math.max(0,pl.flame-dt*1.5); pl.sq+=(0-pl.sq)*Math.min(1,dt*10);
      }
      // camera: follow the middle of the pair, zoom out if the gap won't fit
      const [top,bot]=band(), room=(bot-top)*.9, gap=Math.abs(G.me.wy-G.bot.wy);
      const zt=Math.max(.6,Math.min(1,room/Math.max(1,gap)));   // pull back a little, never so far the race looks tiny cam.z+=(zt-cam.z)*Math.min(1,dt*2.5);
      const ct=(G.me.wy+G.bot.wy)/2, prev=cam.y; cam.vy+=((ct-cam.y)*9-cam.vy*5)*dt; cam.y+=cam.vy*dt; camDy=cam.y-prev;
      for(const pl of [G.me,G.bot]) pl.y=Math.max(top+RH()*.55,Math.min(bot-RH()*.2,screenY(pl.wy)+(pl.syo||0)));   // a huge lead pins to the edges; the gap tag shows the $
    }
    sx.save(); if(sh) sx.translate(rnd(-sh,sh)*.5,rnd(-sh,sh)*.5);
    const camAlt=-cam.y/K; drawBackdrop(camAlt);
    // stars stream with the camera: climbing makes them rush down past you
    const base=G&&G.started?50:25, v=base*dt - camDy*1.4;
    sx.fillStyle="rgba(255,255,255,.75)";
    for(const s of stars){ s.y+=v*s.z; if(s.y>SH){s.y-=SH;s.x=Math.random()*SW;} if(s.y<0){s.y+=SH;s.x=Math.random()*SW;} sx.fillRect(s.x,s.y,1.3*s.z,Math.max(1.5,Math.min(26,Math.abs(v)*1.6))*s.z); }
    if(G){
      drawRuler(); drawGap();
      const lead=Math.abs(profitOf(G.me)-profitOf(G.bot))>0.005?(profitOf(G.me)>profitOf(G.bot)?G.me:G.bot):null;
      for(const pl of [G.bot,G.me]){
        const climbing=pl.wvy<-20;
        if(Math.random()<(climbing?.9:.5)) part({x:lane(pl)+pl.dx+rnd(-4,4),y:pl.y+(pl.me?RH():RH()*.82)*.55,vx:rnd(-20,20),vy:rnd(120,220)+Math.max(0,-pl.wvy*.3),life:rnd(.5,.9),size:rnd(8,15),col:pl.me?"255,226,160":"255,170,210",kind:"smoke",add:false});
        drawRocket(pl,now,lead===pl);
      }
    }
    for(let i=FX.parts.length-1;i>=0;i--){const p=FX.parts[i]; p.life-=dt; if(p.life<=0){FX.parts.splice(i,1);continue;}
      p.vx*=1-p.drag*dt; p.vy=p.vy*(1-p.drag*dt)+p.g*dt; p.x+=p.vx*dt; p.y+=p.vy*dt - camDy*cam.z; const a=p.life/p.max;
      sx.save(); if(p.add) sx.globalCompositeOperation="lighter";
      if(p.kind==="ball"){const r=p.size*(1.2-a*.6); const g=sx.createRadialGradient(p.x,p.y,0,p.x,p.y,r); g.addColorStop(0,`rgba(255,250,230,${a})`); g.addColorStop(.4,`rgba(255,150,60,${a*.8})`); g.addColorStop(1,"rgba(240,48,127,0)"); sx.fillStyle=g; sx.beginPath(); sx.arc(p.x,p.y,r,0,7); sx.fill();}
      else if(p.kind==="smoke"){sx.fillStyle=`rgba(${p.col},${a*.22})`; sx.beginPath(); sx.arc(p.x,p.y,p.size*(1.6-a*.6),0,7); sx.fill();}
      else {sx.fillStyle=`rgba(${p.col},${a})`; sx.beginPath(); sx.arc(p.x,p.y,p.size*a,0,7); sx.fill();}
      sx.restore();}
    for(let i=FX.rings.length-1;i>=0;i--){const r=FX.rings[i]; r.life-=dt; if(r.life<=0){FX.rings.splice(i,1);continue;} r.r+=r.vr*dt; r.y-=camDy*cam.z; const a=r.life/r.max; sx.strokeStyle=`rgba(${r.col},${a})`; sx.lineWidth=r.w*a; sx.beginPath(); sx.arc(r.x,r.y,r.r,0,7); sx.stroke();}
    for(let i=FX.pops.length-1;i>=0;i--){const p=FX.pops[i]; p.age+=dt; if(p.age>p.max){FX.pops.splice(i,1);continue;} const a=1-p.age/p.max, s=p.age<.12?p.age/.12:1;
      sx.font=`800 ${Math.round(p.size*(0.8+.2*s))}px ${GF},sans-serif`; sx.textAlign="center"; sx.textBaseline="middle"; sx.globalAlpha=a;
      sx.lineWidth=5; sx.strokeStyle="rgba(11,10,22,.85)"; sx.strokeText(p.txt,p.x,p.y-p.age*40); sx.fillStyle=p.c; sx.fillText(p.txt,p.x,p.y-p.age*40); sx.globalAlpha=1;}
    sx.restore();
    if(FX.flash>0){ sx.fillStyle=`rgba(${FX.flashC},${FX.flash*.35})`; sx.fillRect(0,0,SW,SH); FX.flash=Math.max(0,FX.flash-dt*2.2); }
  }

  /* ---------- sound + haptics ---------- */
  let ac=null, muted=false;
  try{muted=localStorage.getItem("duel.mute")==="1";}catch(e){}
  function ensureAudio(){ if(!ac){ try{ac=new (window.AudioContext||window.webkitAudioContext)();}catch(e){} } if(ac&&ac.state==="suspended") ac.resume(); }
  function tone(f0,f1,d,v,type){ if(!ac||muted) return; try{const o=ac.createOscillator(),g=ac.createGain(); o.type=type||"sine"; o.frequency.setValueAtTime(f0,ac.currentTime); o.frequency.exponentialRampToValueAtTime(f1,ac.currentTime+d); g.gain.setValueAtTime(v,ac.currentTime); g.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+d); o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime+d);}catch(e){} }
  function noise(d,f,v){ if(!ac||muted) return; try{const b=ac.createBuffer(1,ac.sampleRate*d,ac.sampleRate),c=b.getChannelData(0); for(let i=0;i<c.length;i++)c[i]=Math.random()*2-1; const s=ac.createBufferSource(),fl=ac.createBiquadFilter(),g=ac.createGain(); s.buffer=b; fl.type="lowpass"; fl.frequency.value=f; g.gain.setValueAtTime(v,ac.currentTime); g.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+d); s.connect(fl).connect(g).connect(ac.destination); s.start();}catch(e){} }
  function sfx(k){
    if(k==="boost"){noise(.35,1800,.18); tone(160,520,.3,.05,"sawtooth");}
    else if(k==="dump"){noise(.3,900,.2); tone(700,180,.25,.05,"square");}
    else if(k==="win"){tone(660,990,.12,.08,"triangle"); setTimeout(()=>tone(990,1320,.16,.07,"triangle"),90);}
    else if(k==="lose"){tone(300,180,.25,.06,"triangle");}
    else if(k==="bomb"){noise(1.1,500,.5); tone(120,40,.8,.12,"sawtooth");}
    else if(k==="tick"){tone(880,880,.05,.04,"square");}
    else if(k==="go"){tone(440,880,.25,.08,"triangle");}
    else if(k==="trick"){tone(500,1400,.28,.06,"triangle"); noise(.25,3000,.06);}
    else if(k==="ot"){tone(520,780,.2,.08,"square"); setTimeout(()=>tone(520,780,.2,.08,"square"),220);}
  }
  function buzz(p){ try{ if(navigator.vibrate) navigator.vibrate(p); }catch(e){} }
  function setMute(m){ muted=m; $("mWave").toggleAttribute("hidden",m); $("mX").toggleAttribute("hidden",!m); $("mute").setAttribute("aria-label",m?"Unmute sound":"Mute sound"); try{localStorage.setItem("duel.mute",m?"1":"0");}catch(e){} }
  $("mute").addEventListener("click",()=>{ensureAudio(); setMute(!muted);});

  /* ---------- flow ---------- */
  function start(){
    ensureAudio(); openChat(false); newGame(); for(const k of ["intro","search","invite","vs","result"]) $(k).hidden=true; $("feed").innerHTML="";
    $("botLab").innerHTML=`${esc(G.bot.name).toUpperCase()} \u00b7 <span id="botN">0</span>`;
    FX.parts.length=0; FX.pops.length=0; cam={y:0,vy:0,z:1}; ui();
    const c=$("count"); c.hidden=false; let shown=null;
    const iv=setInterval(()=>{ if(dead){clearInterval(iv);return;} const left=G.startAt-now_(); const n=Math.ceil(left/1000);
      if(left>0){ if(n!==shown&&n<=3){ shown=n; c.textContent=n; sfx("tick"); } return; }
      clearInterval(iv); c.textContent="GO"; sfx("go"); buzz(30); G.started=true; setTimeout(()=>c.hidden=true,450);
      if(!(M&&M.net)&&Math.random()<.6) botSay(pick(["glhf","let's go","you're going down","\ud83e\udee1"]),1500);
      toast(SW>=900?"WASD to fly \u00b7 Space boost \u00b7 Shift dump \u00b7 Enter cash out \u00b7 T chat \u00b7 Q spin \u00b7 E flip":"Drag the sky to steer \u00b7 swipe up to spin \u00b7 double-tap to flip"); },100);
  }
  function end(){
    G.over=true; openChat(false); if(Math.random()<.8) setTimeout(()=>say(G.bot,pick(["gg","gg wp","rematch?"])),200);
    for(const pl of [G.me,G.bot]) if(pl.pos) close(pl);
    showResult(profitOf(G.me),profitOf(G.bot),null);
  }
  function endNet(res){
    if(G.over) return; G.over=true; openChat(false);
    const me=res.books[M.me], them=res.books[M.opp.pid];
    for(const [pl,b] of [[G.me,me],[G.bot,them]]){ if(pl.pos&&b&&!b.pos){ vClose(pl,pl.pos.side,(b.fuel-pl.fuel)-pl.pos.coll,res.price); } if(b) setBook(pl,b); }
    ui(); showResult(res.profit[M.me],res.profit[M.opp.pid],{delta:res.delta[M.me]||0,rating:res.rating[M.me],winner:res.winner});
  }
  function showResult(pm,pb,net){
    const win=pm>pb, tie=Math.abs(pm-pb)<0.005;
    const rec=Object.assign({w:0,l:0,rating:1200,streak:0},REC);
    const dr=net?net.delta:0;
    if(net&&net.rating) { rec.rating=net.rating; if(M.ranked&&!tie){ if(win){rec.w++;rec.streak++;} else {rec.l++;rec.streak=0;} } REC=rec; }
    $("rH").textContent=tie?"DRAW":win?"YOU WIN":"YOU LOSE"; $("rH").style.color=tie?"var(--text)":win?"var(--gold)":"var(--pinkl)";
    const marg=Math.abs(pm-pb), card=document.querySelector(".res");
    card.classList.toggle("win",win&&!tie); $("result").classList.toggle("winbg",win&&!tie); $("rMarg").hidden=tie;
    $("rMargL").textContent=win?"WON BY":"LOST BY"; $("rMargV").textContent="$"+marg.toFixed(2); $("rMargV").style.color=win?"":"var(--pinkl)";
    $("rSub").textContent=tie?"Dead even.":win
      ? (pm>=0 ? `You out-traded ${esc(G.bot.name)}. Clean win.` : pb<0 ? `Rough tape for both. You read it better and took the W.` : `You out-traded ${esc(G.bot.name)} when it counted.`)
      : `${esc(G.bot.name)} edged it. Run it back.`;
    // the winner's card wears the crown; your red number goes quiet when you won anyway
    $("rMe").textContent=usd(pm,true); $("rMe").style.color=win&&pm<0?"var(--text)":pm>=0?"var(--green)":"var(--pinkl)";
    document.querySelector(".sc.me").classList.toggle("won",win&&!tie);
    document.querySelector(".sc.me small").innerHTML=win&&!tie?`you <span class="crown">WINNER</span>`:"you";
    $("rBot").textContent=usd(pb,true); $("rBot").style.color=pb>=0?"var(--green)":"var(--pinkl)"; $("rBotN").textContent=G.bot.name+(M&&!M.net?" \u00b7 bot":"");
    $("rMeS").textContent=`${G.me.trades} trades \u00b7 ${G.me.green} green \u00b7 $${G.me.fees.toFixed(2)} fees`;
    $("rBotS").textContent=`${G.bot.trades} trades \u00b7 ${G.bot.green} green \u00b7 $${G.bot.fees.toFixed(2)} fees`;
    const all=[...G.me.moments,...G.bot.moments].sort((a,b)=>Math.abs(b.v)-Math.abs(a.v)).slice(0,5).sort((a,b)=>a.t-b.t);
    $("rMom").innerHTML=all.length?all.map(m=>`<div><span><span class="t">${mmss(m.t)}</span>${m.txt}</span><b style="color:${m.v>=0?"var(--green)":"var(--pinkl)"}">${usd(m.v,true)}</b></div>`).join(""):`<div><span>No trades this time.</span></div>`;
    $("rRec").textContent=`${rec.w}-${rec.l}`; $("rRat").parentElement.querySelector("small").textContent=net&&M.ranked?"Rating":"Rating (unranked)"; $("rRat").innerHTML=`${rec.rating.toLocaleString("en-US")} <span style="font-size:14px;color:${dr>=0?"var(--green)":"var(--pinkl)"}">${dr>=0?"+":"\u2212"}${Math.abs(dr)}</span>`; $("rStr").textContent=rec.streak;
    $("rAgain").textContent="REMATCH";
    sfx(win?"win":"lose"); buzz(win?[20,40,20,40,60]:[80]);
    if(win&&!tie&&!reduce){ const cols=["242,193,78","95,240,160","255,255,255","255,143,189","143,184,255"]; for(let k=0;k<3;k++) setTimeout(()=>{ for(let i=0;i<70;i++) part({x:SW*(.2+Math.random()*.6),y:SH*.25,vx:rnd(-260,260),vy:rnd(-520,-120),g:520,drag:.6,life:rnd(1.6,2.6),size:rnd(3,6),col:cols[i%cols.length],add:false}); },k*350); }
    setTimeout(()=>{$("result").hidden=false; $("rAgain").focus();},700);
  }

  /* ---- lobby + matchmaking: every step goes through the host (server calls); the screens are the prototype's ---- */
  let REC={w:0,l:0,rating:1200,streak:0}, SIGNED=false, mode="ranked", vIv=0, waitT=0;
  function paintLobby(){ $("lRat").textContent=REC.rating.toLocaleString("en-US"); $("lRec").textContent=`${REC.w}-${REC.l} \u00b7 ${botKey.toUpperCase()}`;
    $("go").textContent=SIGNED?"FIND A MATCH":"SIGN IN TO DUEL"; $("mkLink").textContent=SIGNED?"CREATE DUEL LINK":"SIGN IN TO DUEL"; }
  function show(id){ for(const k of ["intro","search","invite","vs","result"]) $(k).hidden=k!==id; if(id==="intro"){ paintLobby(); lerr(""); } }
  function lerr(t){ $("lErr").textContent=t||""; }
  function lenTxt(){ return LEN>=180000?"3 MIN":"1 MIN"; }
  document.querySelectorAll(".duel-root .tab").forEach(t=>t.addEventListener("click",()=>{ mode=t.dataset.tab; document.querySelectorAll(".duel-root .tab").forEach(x=>x.classList.toggle("on",x===t)); document.querySelectorAll(".duel-root [data-pane]").forEach(p=>p.hidden=p.dataset.pane!==mode); lerr(""); }));
  document.querySelectorAll(".duel-root [data-bot]").forEach(b=>{b.classList.toggle("on",b.dataset.bot===botKey); b.addEventListener("click",()=>{botKey=b.dataset.bot; document.querySelectorAll(".duel-root [data-bot]").forEach(x=>x.classList.toggle("on",x===b)); try{localStorage.setItem("duel.tier",botKey);}catch(e){} paintLobby();});});
  document.querySelectorAll(".duel-root [data-len]").forEach(b=>{b.classList.toggle("on",+b.dataset.len*1000===LEN); b.addEventListener("click",()=>{LEN=+b.dataset.len*1000; document.querySelectorAll(".duel-root [data-len]").forEach(x=>x.classList.toggle("on",x===b)); try{localStorage.setItem("duel.len",LEN);}catch(e){}});});
  $("go").addEventListener("click",()=>{ ensureAudio(); if(!SIGNED){ host.signIn(); return; } mode="ranked"; show("search"); $("sH").textContent="FINDING A RIVAL"; $("sBot").hidden=true; $("sT").textContent="0:00";
    $("sSub").textContent=`${botKey.toUpperCase()} \u00b7 ${lenTxt()} \u00b7 near ${REC.rating.toLocaleString("en-US")}`; host.quickMatch(botKey,LEN); });
  $("sCancel").addEventListener("click",()=>{ host.cancelSearch(); show("intro"); });
  $("sBot").addEventListener("click",()=>{ host.cancelSearch(); practice(); });
  $("lPractice").addEventListener("click",()=>{ ensureAudio(); practice(); });
  $("mkLink").addEventListener("click",()=>{ ensureAudio(); if(!SIGNED){ host.signIn(); return; } mode="friend"; lerr(""); host.createLink(botKey,LEN); });
  $("iCopy").addEventListener("click",()=>{ const t=$("iLink").dataset.url||""; try{navigator.clipboard.writeText(t); toast("Link copied");}catch(e){ toast(t); } });
  $("iX").addEventListener("click",()=>{ const t=encodeURIComponent(`1v1 me in a trading duel on DISCIPLE \u2694\ufe0f ${$("iCode").textContent}`), u=encodeURIComponent($("iLink").dataset.url||""); window.open(`https://x.com/intent/post?text=${t}&url=${u}`,"_blank","noopener"); });
  $("iCancel").addEventListener("click",()=>{ host.leave(); show("intro"); });
  $("joinF").addEventListener("submit",e=>{ e.preventDefault(); if(!SIGNED){ host.signIn(); return; } const v=$("joinI").value.trim(); if(!v) return; ensureAudio(); mode="friend"; lerr(""); host.join(v); });
  function practice(){ M={net:false,ranked:false}; OFF=0; opp={name:BOTS[botKey].name,bot:true}; openVs("BOT MATCH",{name:BOTS[botKey].name,bot:true},"bot match \u00b7 no rating"); }
  let opp=null;
  function openVs(tag,o,kind){ show("vs"); opp=o; $("vTag").textContent=tag; $("vName").textContent=o.name; $("vAv").textContent=o.name.replace("@","").slice(0,2).toUpperCase();
    $("vMe").textContent=`${REC.rating.toLocaleString("en-US")} \u00b7 ${REC.w}-${REC.l}`; $("vThem").textContent=o.bot?"bot":`${(o.rating||1200).toLocaleString("en-US")} \u00b7 ${o.w||0}-${o.l||0}`;
    $("vSub").textContent=`${botKey.toUpperCase()} \u00b7 $${TIERS[botKey].fuel} fuel each \u00b7 ${lenTxt()} \u00b7 ${kind}`;
    for(const id of ["vMeR","vThemR"]){ $(id).classList.toggle("on",!!(id==="vThemR"&&o.ready)); $(id).textContent=id==="vThemR"&&o.ready?"READY":"NOT READY"; }
    $("vReady").disabled=false; $("vReady").textContent="READY"; $("vAuto").hidden=!!o.bot;
    let n=10; $("vT").textContent=n; clearInterval(vIv); if(!o.bot) vIv=setInterval(()=>{ n--; $("vT").textContent=Math.max(0,n); if(n<=0){ clearInterval(vIv); meReady(); } },1000); }
  function meReady(){ clearInterval(vIv); $("vMeR").classList.add("on"); $("vMeR").textContent="READY"; $("vReady").disabled=true; $("vReady").textContent="WAITING\u2026"; sfx("tick");
    if(M&&!M.net){ setTimeout(()=>{ M.startAt=Date.now()+3500; M.endAt=M.startAt+LEN; start(); },350); return; }
    host.ready(); }
  $("vReady").addEventListener("click",meReady);
  $("vLeave").addEventListener("click",()=>{ clearInterval(vIv); if(M&&M.net) host.leave(); M=null; show("intro"); });
  $("rAgain").addEventListener("click",()=>{ if(M&&!M.net){ practice(); return; } $("rAgain").disabled=true; $("rAgain").textContent="WAITING\u2026"; host.rematch(); });
  $("rBack").addEventListener("click",()=>{ if(M&&M.net) host.toLobby(); M=null; show("intro"); });
  paintLobby();
  function setStake(v){stake=v; if(G) ui(); else paintSizes();}
  document.querySelectorAll(".size button").forEach(b=>b.addEventListener("click",()=>setStake(SIZES[+b.dataset.i])));
  $("quick").innerHTML=QUICK.map(q=>`<button type="button">${q}</button>`).join("");
  $("quick").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{ meSay(b.textContent); if(SW<900) openChat(false); }));
  function openChat(o){ $("chat").hidden=!o; if(o){ $("chatDot").hidden=true; if(SW>=900) $("sayI").focus(); } else $("sayI").blur(); }
  $("chatB").addEventListener("click",()=>openChat($("chat").hidden));
  $("sayF").addEventListener("submit",e=>{ e.preventDefault(); const i=$("sayI"); if(i.value.trim()) meSay(i.value); i.value=""; if(SW<900) openChat(false); });
  sky.addEventListener("pointerdown",skyDown); sky.addEventListener("pointermove",skyMove); sky.addEventListener("pointerup",skyUp); sky.addEventListener("pointercancel",()=>drag=null);
  $("bBoost").addEventListener("click",()=>act("b")); $("bDump").addEventListener("click",()=>act("d"));
  $("bOut").addEventListener("click",()=>act("x"));
  const keys={l:false,r:false,u:false,dn:false};
  const KEYMAP={a:"l",arrowleft:"l",d:"r",arrowright:"r",w:"u",arrowup:"u",s:"dn",arrowdown:"dn"};
  on(window,"keyup",e=>{const m=KEYMAP[e.key.toLowerCase()]; if(m) keys[m]=false;});
  on(window,"keydown",e=>{
    if($("intro").hidden===false||$("vs").hidden===false||$("search").hidden===false||$("invite").hidden===false){ if(e.target&&e.target.id==="joinI") return; }
    if(e.target&&e.target.id==="sayI"){ if(e.key==="Escape") openChat(false); return; }
    if(e.key.toLowerCase()==="t"&&!e.repeat){ e.preventDefault(); openChat(true); return; }
    if(e.key==="Escape"&&!$("chat").hidden){ openChat(false); return; }
    const k=e.key.toLowerCase(), m=KEYMAP[k];
    if(m){ e.preventDefault(); keys[m]=true; return; }
    if(e.repeat) return;
    const live=G&&G.started&&!G.over;
    if(k===" "){ if(live){e.preventDefault();act("b");} }
    else if(k==="shift"){ if(live){e.preventDefault();act("d");} }
    else if(k==="enter"){ if(live){e.preventDefault();act("x");} }
    else if(k==="f"){act("f");}
    else if(k==="q"){trick(G&&G.me,"spin");}
    else if(k==="e"){trick(G&&G.me,"flip");}
    else if(k>="1"&&k<="5"){setStake(SIZES[+k-1]);}
  });
  setMute(muted);
  resize(); newGame(); ui(); requestAnimationFrame(frame);
  show("intro");

  return {
    price:(p,ts)=>pushPrice(p,ts),
    setMe:(rec,signed)=>{ REC=Object.assign({w:0,l:0,rating:1200,streak:0},rec||{}); SIGNED=!!signed; paintLobby(); },
    setClock:(serverNow)=>{ OFF=serverNow-Date.now(); },
    searching:(waitedMs,window_,botOffer)=>{ $("sT").textContent=mmss(waitedMs+999); $("sSub").textContent=`${botKey.toUpperCase()} \u00b7 ${lenTxt()} \u00b7 ${REC.rating-window_}\u2013${REC.rating+window_}`; if(botOffer&&$("sBot").hidden){ $("sBot").hidden=false; $("sH").textContent="STILL LOOKING"; } },
    invite:(code,url)=>{ $("iCode").textContent="DUEL-"+code; $("iLink").textContent=url.replace(/^https?:\/\//,""); $("iLink").dataset.url=url; $("iSub").textContent=`${botKey.toUpperCase()} \u00b7 $${TIERS[botKey].fuel} fuel each \u00b7 ${lenTxt()}`; $("iWait").textContent="Waiting for your friend to open the link\u2026"; show("invite"); },
    room:(r,meId)=>{ // lobby state of a server room
      if(r.tier&&TIERS[r.tier]) botKey=r.tier; if(r.lenMs) LEN=r.lenMs;
      const o=r.players.find(p=>p.pid!==meId), me=r.players.find(p=>p.pid===meId);
      if(!o) return;
      M={net:true,ranked:r.mode==="ranked",me:meId,opp:{pid:o.pid,name:o.name},startAt:r.startAt,endAt:r.endAt};
      if(r.status==="lobby"){ const fresh=$("vs").hidden; if(fresh) openVs(r.mode==="ranked"?"MATCH FOUND":"FRIEND JOINED",{name:o.name,rating:o.rating,w:o.record.w,l:o.record.l,ready:o.ready},r.mode==="ranked"?"ranked":"friendly \u00b7 no rating");
        else { $("vThemR").classList.toggle("on",o.ready); $("vThemR").textContent=o.ready?"READY":"NOT READY"; if(me&&me.ready){ $("vMeR").classList.add("on"); $("vMeR").textContent="READY"; } } }
      else if(r.status==="live"&&(!G||G.startAt!==r.startAt||G.over)){ start(); for(const p of r.players){ const pl=p.pid===meId?G.me:G.bot; if(r.books[p.pid]) setBook(pl,r.books[p.pid]); } if(r.ot){G.ot=true;} ui(); }
      else if(r.status==="cancelled"){ toast(`${esc(o.name)} left the lobby`); M=null; show("intro"); }
    },
    event:(ev)=>onEvent(ev),
    error:(t)=>{ if(!$("intro").hidden) lerr(t); else toast(t); if(!$("search").hidden||!$("invite").hidden){ show("intro"); lerr(t); } if(!$("result").hidden){ $("rAgain").disabled=false; $("rAgain").textContent="REMATCH"; } },
    toLobby:()=>{ M=null; show("intro"); },
    _state:()=>G,
    destroy:()=>{ dead=true; offs.forEach(f=>f()); try{ if(ac) ac.close(); }catch(e){} root.innerHTML=""; root.classList.remove("duel-root"); },
  };
}
window.DuelEngine={mount};
})();
