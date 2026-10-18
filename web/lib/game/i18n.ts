/**
 * Lightweight i18n for the GAME HUD (flight page React overlays: ESC settings menu, PnL HUD, trade bar, pills).
 * English is the source of truth; other locales fall back to English per key.
 *
 * BRAND / NATIVE REVIEW NEEDED: the zh / ko / ja / es strings below are DRAFT machine-assisted translations written
 * for layout and wiring. Every non-English entry must be reviewed by BRAND + a native speaker before launch
 * (status: NEEDS_REVIEW). Game terms kept in English on purpose (BOOST, DUMP, PnL, MCAP, $TICKER, Touch Grass is translated).
 * Canvas text drawn by public/flight/engine.js is not covered yet (follow-up).
 */
import { useCallback } from "react";
import { useGameSettings, type Locale } from "./settings";

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" }, { id: "zh", label: "中文" }, { id: "ko", label: "한국어" }, { id: "ja", label: "日本語" }, { id: "es", label: "Español" },
];
/** BRAND/native review status per locale (en = source). */
export const REVIEW_STATUS: Record<Locale, "source" | "NEEDS_REVIEW"> = { en: "source", zh: "NEEDS_REVIEW", ko: "NEEDS_REVIEW", ja: "NEEDS_REVIEW", es: "NEEDS_REVIEW" };

const en = {
  "settings.title": "SETTINGS",
  "settings.open": "Settings (Esc)",
  "settings.close": "Close (Esc)",
  "settings.paused": "Game hotkeys are paused while this menu is open",
  "sec.share": "Share",
  "share.trade": "Share your trade",
  "share.card": "Download rocket card",
  "sec.hotkeys": "Hotkeys",
  "hk.buy": "Buy presets",
  "hk.sell": "Sell sizes",
  "hk.press": "press a key…",
  "hk.reset": "Reset keys",
  "hk.auto": "Auto-scale buy amounts with mcap",
  "hk.save": "Save amounts",
  "hk.saved": "Saved",
  "hk.reserved": "That key is reserved",
  "hk.note": "Preset keys only select. SPACE boosts the active amount (custom $ wins), SHIFT dumps the selected size.",
  "sec.audio": "Sound",
  "audio.sfx": "Sound effects",
  "audio.music": "Music",
  "audio.note": "No sounds ship yet: these settings are saved and apply when they do.",
  "sec.lang": "Language",
  "lang.review": "Translations are drafts pending native review.",
  "sec.display": "Display",
  "disp.grass": "Touch Grass",
  "disp.grassHint": "ambient: rocket + $TICKER · MCAP only (G)",
  "disp.orbs": "Orbs",
  "disp.orbsHint": "collectible orbs in the sky (O)",
  "sec.controls": "Controls",
  "ctl.space": "BOOST: buy the active amount (custom $ wins)",
  "ctl.shift": "DUMP: sell the selected size (custom sell wins)",
  "ctl.buyKeys": "select a buy preset (no trade)",
  "ctl.sellKeys": "select a sell size (no trade)",
  "ctl.click": "click preset: select only",
  "ctl.w": "thrust visual (hold, no trade)",
  "ctl.ad": "steer (idle 1.5 s re-centres)",
  "ctl.p": "position tag on rocket",
  "ctl.g": "touch grass (ambient view)",
  "ctl.o": "orbs on/off",
  "ctl.b": "bombs on/off",
  "ctl.enter": "chat",
  "ctl.h": "chat ↔ holders",
  "ctl.esc": "this menu",
  "ctl.pending": "pending",
  "ctl.points": "POINTS",
  "ctl.streak": "streak",
  "ctl.shot": "BUY {shot}/shot",
  "on": "ON",
  "off": "OFF",
  "pnl.yourRun": "YOUR RUN",
  "pnl.paper": "PAPER",
  "pnl.unrealized": "UNREALIZED PNL",
  "pnl.mcap": "MCAP",
  "pnl.holdings": "HOLDINGS",
  "pnl.avgEntry": "AVG ENTRY",
  "pnl.realized": "REALIZED",
  "pnl.exitFees": "EXIT FEES",
  "pnl.other": "OTHER ROCKETS",
  "pnl.points": "POINTS",
  "pnl.hintUp": "▲ more uPnL → bigger points multiplier · hold to ramp",
  "pnl.hintFlat": "stay green to earn a bigger points multiplier",
  "pnl.pctTitle": "uPnL ÷ cost basis (incl. buy fee + gas) = MCAP ÷ AVG ENTRY MC − 1. Marked at the current price, before exit fee and price impact.",
  "tb.boost": "BOOST",
  "tb.dump": "DUMP",
  "tb.custom": "custom",
  "tb.noPos": "no position",
  "tb.pos": "pos",
  "tb.noTokens": "NO TOKENS IN WALLET",
  "sim.on": "◆ SIMULATED MARKET · ON",
  "sim.off": "◇ SIMULATED MARKET · OFF",
  "sim.auto": "(auto)",
  "exit": "Back to Launchpad",
} as const;
export type I18nKey = keyof typeof en;
type Dict = Partial<Record<I18nKey, string>>;

// NEEDS_REVIEW (BRAND + native speaker): draft translations below.
const zh: Dict = {
  "settings.title": "设置", "settings.open": "设置 (Esc)", "settings.close": "关闭 (Esc)", "settings.paused": "菜单打开时游戏快捷键暂停",
  "sec.share": "分享", "share.trade": "分享你的交易", "share.card": "下载火箭卡片",
  "sec.hotkeys": "快捷键", "hk.buy": "买入预设", "hk.sell": "卖出比例", "hk.press": "请按一个键…", "hk.reset": "重置按键", "hk.auto": "买入金额随市值自动缩放",
  "hk.save": "保存金额", "hk.saved": "已保存", "hk.reserved": "该按键已被占用",
  "hk.note": "预设键只做选择。空格 BOOST 使用当前金额（自定义金额优先），SHIFT 按所选比例 DUMP。",
  "sec.audio": "声音", "audio.sfx": "音效", "audio.music": "音乐", "audio.note": "暂未加入声音：设置会保存，加入后自动生效。",
  "sec.lang": "语言", "lang.review": "译文为草稿，待母语审校。",
  "sec.display": "显示", "disp.grass": "出去走走", "disp.grassHint": "氛围模式：仅显示火箭 + $代币 · 市值 (G)", "disp.orbs": "光球", "disp.orbsHint": "天空中的可收集光球 (O)",
  "sec.controls": "操作说明", "ctl.space": "BOOST：买入当前金额（自定义金额优先）", "ctl.shift": "DUMP：卖出所选比例（自定义卖出优先）",
  "ctl.buyKeys": "选择买入预设（不交易）", "ctl.sellKeys": "选择卖出比例（不交易）", "ctl.click": "点击预设：仅选择", "ctl.w": "推进特效（按住，不交易）",
  "ctl.ad": "转向（闲置 1.5 秒自动回正）", "ctl.p": "火箭旁显示持仓标签", "ctl.g": "出去走走（氛围视图）", "ctl.o": "开关光球", "ctl.b": "开关炸弹",
  "ctl.enter": "聊天", "ctl.h": "聊天 ↔ 持有者", "ctl.esc": "本菜单", "ctl.pending": "待确认", "ctl.points": "积分", "ctl.streak": "连击", "ctl.shot": "每次买入 {shot}",
  "on": "开", "off": "关",
  "pnl.yourRun": "你的航程", "pnl.paper": "模拟", "pnl.unrealized": "未实现盈亏", "pnl.mcap": "市值", "pnl.holdings": "持仓", "pnl.avgEntry": "平均入场",
  "pnl.realized": "已实现", "pnl.exitFees": "退出费用", "pnl.other": "其他火箭", "pnl.points": "积分",
  "pnl.hintUp": "▲ 未实现盈亏越高 → 积分倍数越大 · 持有以提升", "pnl.hintFlat": "保持盈利以获得更高积分倍数",
  "pnl.pctTitle": "未实现盈亏 ÷ 成本（含买入手续费 + Gas）= 市值 ÷ 平均入场市值 − 1。按当前价格计价，未扣除退出费用与价格冲击。",
  "tb.custom": "自定义", "tb.noPos": "无持仓", "tb.pos": "持仓", "tb.noTokens": "钱包中没有代币",
  "sim.on": "◆ 模拟市场 · 开", "sim.off": "◇ 模拟市场 · 关", "sim.auto": "（自动）", "exit": "返回发射台",
};
const ko: Dict = {
  "settings.title": "설정", "settings.open": "설정 (Esc)", "settings.close": "닫기 (Esc)", "settings.paused": "메뉴가 열려 있는 동안 게임 단축키가 일시 중지됩니다",
  "sec.share": "공유", "share.trade": "내 거래 공유", "share.card": "로켓 카드 다운로드",
  "sec.hotkeys": "단축키", "hk.buy": "매수 프리셋", "hk.sell": "매도 비율", "hk.press": "키를 누르세요…", "hk.reset": "키 초기화", "hk.auto": "시가총액에 맞춰 매수 금액 자동 조정",
  "hk.save": "금액 저장", "hk.saved": "저장됨", "hk.reserved": "이미 사용 중인 키입니다",
  "hk.note": "프리셋 키는 선택만 합니다. SPACE는 현재 금액으로 BOOST(직접 입력 금액 우선), SHIFT는 선택한 비율로 DUMP합니다.",
  "sec.audio": "사운드", "audio.sfx": "효과음", "audio.music": "음악", "audio.note": "아직 사운드가 없습니다. 설정은 저장되며 추가되면 적용됩니다.",
  "sec.lang": "언어", "lang.review": "번역은 초안이며 원어민 검토가 필요합니다.",
  "sec.display": "화면", "disp.grass": "잔디 만지기", "disp.grassHint": "감상 모드: 로켓 + $티커 · 시총만 표시 (G)", "disp.orbs": "오브", "disp.orbsHint": "하늘의 수집형 오브 (O)",
  "sec.controls": "조작법", "ctl.space": "BOOST: 현재 금액 매수 (직접 입력 금액 우선)", "ctl.shift": "DUMP: 선택한 비율 매도 (직접 입력 매도 우선)",
  "ctl.buyKeys": "매수 프리셋 선택 (거래 없음)", "ctl.sellKeys": "매도 비율 선택 (거래 없음)", "ctl.click": "프리셋 클릭: 선택만", "ctl.w": "추진 효과 (누르고 있기, 거래 없음)",
  "ctl.ad": "방향 전환 (1.5초 후 자동 정렬)", "ctl.p": "로켓 옆 포지션 태그", "ctl.g": "잔디 만지기 (감상 화면)", "ctl.o": "오브 켜기/끄기", "ctl.b": "폭탄 켜기/끄기",
  "ctl.enter": "채팅", "ctl.h": "채팅 ↔ 홀더", "ctl.esc": "이 메뉴", "ctl.pending": "대기 중", "ctl.points": "포인트", "ctl.streak": "연속", "ctl.shot": "1회 매수 {shot}",
  "on": "켜짐", "off": "꺼짐",
  "pnl.yourRun": "나의 비행", "pnl.paper": "모의", "pnl.unrealized": "미실현 손익", "pnl.mcap": "시총", "pnl.holdings": "보유", "pnl.avgEntry": "평균 진입",
  "pnl.realized": "실현 손익", "pnl.exitFees": "청산 수수료", "pnl.other": "다른 로켓", "pnl.points": "포인트",
  "pnl.hintUp": "▲ 미실현 손익 증가 → 포인트 배수 상승 · 보유할수록 상승", "pnl.hintFlat": "수익을 유지하면 포인트 배수가 커집니다",
  "pnl.pctTitle": "미실현 손익 ÷ 원가(매수 수수료 + 가스 포함) = 시총 ÷ 평균 진입 시총 − 1. 현재 가격 기준이며 청산 수수료와 가격 영향은 제외됩니다.",
  "tb.custom": "직접 입력", "tb.noPos": "포지션 없음", "tb.pos": "포지션", "tb.noTokens": "지갑에 토큰이 없습니다",
  "sim.on": "◆ 시뮬레이션 시장 · 켜짐", "sim.off": "◇ 시뮬레이션 시장 · 꺼짐", "sim.auto": "(자동)", "exit": "런치패드로 돌아가기",
};
const ja: Dict = {
  "settings.title": "設定", "settings.open": "設定 (Esc)", "settings.close": "閉じる (Esc)", "settings.paused": "メニュー表示中はゲームのホットキーが停止します",
  "sec.share": "シェア", "share.trade": "トレードをシェア", "share.card": "ロケットカードを保存",
  "sec.hotkeys": "ホットキー", "hk.buy": "買いプリセット", "hk.sell": "売りサイズ", "hk.press": "キーを押してください…", "hk.reset": "キーをリセット", "hk.auto": "時価総額に合わせて買い金額を自動調整",
  "hk.save": "金額を保存", "hk.saved": "保存しました", "hk.reserved": "そのキーは予約済みです",
  "hk.note": "プリセットキーは選択のみ。SPACEで現在の金額をBOOST（カスタム金額優先）、SHIFTで選択サイズをDUMP。",
  "sec.audio": "サウンド", "audio.sfx": "効果音", "audio.music": "音楽", "audio.note": "サウンドは未実装です。設定は保存され、追加時に反映されます。",
  "sec.lang": "言語", "lang.review": "翻訳は下書きです（ネイティブ確認待ち）。",
  "sec.display": "表示", "disp.grass": "タッチグラス", "disp.grassHint": "鑑賞モード：ロケット + $ティッカー · 時価総額のみ (G)", "disp.orbs": "オーブ", "disp.orbsHint": "空の収集オーブ (O)",
  "sec.controls": "操作方法", "ctl.space": "BOOST：現在の金額で買う（カスタム金額優先）", "ctl.shift": "DUMP：選択サイズを売る（カスタム売り優先）",
  "ctl.buyKeys": "買いプリセットを選択（取引なし）", "ctl.sellKeys": "売りサイズを選択（取引なし）", "ctl.click": "プリセットをクリック：選択のみ", "ctl.w": "推進エフェクト（長押し、取引なし）",
  "ctl.ad": "旋回（1.5秒操作なしで中央へ）", "ctl.p": "ロケット横のポジションタグ", "ctl.g": "タッチグラス（鑑賞ビュー）", "ctl.o": "オーブ オン/オフ", "ctl.b": "ボム オン/オフ",
  "ctl.enter": "チャット", "ctl.h": "チャット ↔ ホルダー", "ctl.esc": "このメニュー", "ctl.pending": "保留中", "ctl.points": "ポイント", "ctl.streak": "連続", "ctl.shot": "1回の買い {shot}",
  "on": "オン", "off": "オフ",
  "pnl.yourRun": "あなたのフライト", "pnl.paper": "ペーパー", "pnl.unrealized": "含み損益", "pnl.mcap": "時価総額", "pnl.holdings": "保有", "pnl.avgEntry": "平均取得",
  "pnl.realized": "確定損益", "pnl.exitFees": "決済手数料", "pnl.other": "他のロケット", "pnl.points": "ポイント",
  "pnl.hintUp": "▲ 含み益が増えるほどポイント倍率アップ · 保有で上昇", "pnl.hintFlat": "プラスを保つとポイント倍率が上がります",
  "pnl.pctTitle": "含み損益 ÷ 取得コスト（買い手数料 + ガス込み）= 時価総額 ÷ 平均取得時価総額 − 1。現在価格で評価、決済手数料と価格影響は含みません。",
  "tb.custom": "カスタム", "tb.noPos": "ポジションなし", "tb.pos": "ポジ", "tb.noTokens": "ウォレットにトークンがありません",
  "sim.on": "◆ シミュレーション市場 · オン", "sim.off": "◇ シミュレーション市場 · オフ", "sim.auto": "（自動）", "exit": "ローンチパッドに戻る",
};
const es: Dict = {
  "settings.title": "AJUSTES", "settings.open": "Ajustes (Esc)", "settings.close": "Cerrar (Esc)", "settings.paused": "Los atajos del juego se pausan mientras este menú está abierto",
  "sec.share": "Compartir", "share.trade": "Comparte tu operación", "share.card": "Descargar tarjeta del cohete",
  "sec.hotkeys": "Atajos", "hk.buy": "Montos de compra", "hk.sell": "Tamaños de venta", "hk.press": "pulsa una tecla…", "hk.reset": "Restablecer teclas", "hk.auto": "Escalar montos de compra con el mcap",
  "hk.save": "Guardar montos", "hk.saved": "Guardado", "hk.reserved": "Esa tecla está reservada",
  "hk.note": "Las teclas de preset solo seleccionan. ESPACIO hace BOOST con el monto activo (el $ personalizado manda), SHIFT hace DUMP del tamaño elegido.",
  "sec.audio": "Sonido", "audio.sfx": "Efectos de sonido", "audio.music": "Música", "audio.note": "Aún no hay sonidos: estos ajustes se guardan y se aplicarán cuando lleguen.",
  "sec.lang": "Idioma", "lang.review": "Las traducciones son borradores pendientes de revisión nativa.",
  "sec.display": "Pantalla", "disp.grass": "Tocar pasto", "disp.grassHint": "modo ambiente: solo cohete + $TICKER · MCAP (G)", "disp.orbs": "Orbes", "disp.orbsHint": "orbes coleccionables en el cielo (O)",
  "sec.controls": "Controles", "ctl.space": "BOOST: compra el monto activo (el $ personalizado manda)", "ctl.shift": "DUMP: vende el tamaño elegido (la venta personalizada manda)",
  "ctl.buyKeys": "elige un monto de compra (sin operar)", "ctl.sellKeys": "elige un tamaño de venta (sin operar)", "ctl.click": "clic en preset: solo selecciona", "ctl.w": "efecto de empuje (mantener, sin operar)",
  "ctl.ad": "girar (se recentra tras 1,5 s)", "ctl.p": "etiqueta de posición en el cohete", "ctl.g": "tocar pasto (vista ambiente)", "ctl.o": "orbes sí/no", "ctl.b": "bombas sí/no",
  "ctl.enter": "chat", "ctl.h": "chat ↔ holders", "ctl.esc": "este menú", "ctl.pending": "pendientes", "ctl.points": "PUNTOS", "ctl.streak": "racha", "ctl.shot": "COMPRA {shot}/disparo",
  "on": "SÍ", "off": "NO",
  "pnl.yourRun": "TU VUELO", "pnl.paper": "PAPEL", "pnl.unrealized": "PNL NO REALIZADO", "pnl.mcap": "MCAP", "pnl.holdings": "TENENCIA", "pnl.avgEntry": "ENTRADA PROM.",
  "pnl.realized": "REALIZADO", "pnl.exitFees": "COMISIONES DE SALIDA", "pnl.other": "OTROS COHETES", "pnl.points": "PUNTOS",
  "pnl.hintUp": "▲ más uPnL → mayor multiplicador de puntos · mantén para subir", "pnl.hintFlat": "mantente en verde para un multiplicador mayor",
  "pnl.pctTitle": "uPnL ÷ costo (incl. comisión de compra + gas) = MCAP ÷ MC de entrada promedio − 1. Valorado al precio actual, antes de la comisión de salida y el impacto de precio.",
  "tb.custom": "personalizado", "tb.noPos": "sin posición", "tb.pos": "pos", "tb.noTokens": "NO HAY TOKENS EN LA BILLETERA",
  "sim.on": "◆ MERCADO SIMULADO · SÍ", "sim.off": "◇ MERCADO SIMULADO · NO", "sim.auto": "(auto)", "exit": "Volver al Launchpad",
};
export const DICTS: Record<Locale, Dict> = { en, zh, ko, ja, es };

export function translate(lang: Locale, key: I18nKey, vars?: Record<string, string | number>): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
/** const t = useT(); t("pnl.mcap") — re-renders when the language changes in the ESC menu. */
export function useT() {
  const lang = useGameSettings().lang;
  return useCallback((key: I18nKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}
