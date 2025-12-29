export const runtime = "nodejs";

import OpenAI from "openai";
import { CHARACTERS, type CharacterId } from "../../lib/characters";

/**
 * 목표
 * - 장문(문서형) 금지: 2~4줄, 최대 3문장 + 질문 1개
 * - 캐릭터 말투 뚜렷하게
 * - 학교/맛집/영업시간/규정 등 "객관 정보"는: 웹검색 켜서 사실 확인 후 답 (BUT 출처/URL은 화면에 절대 표시 X)
 * - 확실하지 않으면 지어내지 말기(진실성 규칙)
 * - "기억": 클라이언트가 보내는 history를 모델 input에 포함
 * - 속도: timeout 짧게 + 재시도 최소 + 출력 토큰 제한
 */

type ClientMessage = {
  from: "user" | "bot";
  text: string;
};

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getCharacter(characterId: CharacterId) {
  return CHARACTERS.find((c) => c.id === characterId) ?? null;
}

/** --- 텍스트 후처리: 장문/목록 제거 + 짧게 자르기 --- */
function stripMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^\d+\)\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 출처/URL/링크 텍스트를 답변에서 완전히 제거 (검색은 하되 UI에는 안 보이게) */
function removeSourcesAndUrls(text: string) {
  return text
    .replace(/^출처\s*:\s*.*$/gim, "")
    .replace(/^sources?\s*:\s*.*$/gim, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/www\.\S+/g, "")
    .replace(/utm_\w+=\S+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function takeFirstSentences(text: string, maxSentences = 3) {
  const cleaned = text.replace(/\r/g, "").trim();
  const parts = cleaned
    .split(/(?<=[.!?。]|요\.)\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = parts.slice(0, maxSentences).join("\n");
  return out.trim();
}

function clampLines(text: string, maxLines = 4) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, maxLines).join("\n");
}

function ensureConversationalEnding(characterId: CharacterId, text: string) {
  if (/[?？]\s*$/.test(text) || text.includes("?") || text.includes("？")) return text;

  switch (characterId) {
    case "cow":
      return `${text}\n지금 제일 급한 게 뭐야??`;
    case "zara":
      return `${text}\n지금 어디부터 막혔는지 한 줄만 말해줄래…?`;
    case "cat":
      return `${text}\n원하는 분위기가 뭐냥?`;
    case "goose":
      return `${text}\n지금 가장 힘든 포인트가 뭐야 꽉?`;
    default:
      return `${text}\n지금 상황을 한 줄로 말해줄래?`;
  }
}

/** --- 캐릭터 말버릇 --- */
function endsWithGgakEveryLine(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.endsWith("꽉") || trimmed.endsWith("꽉?")) return trimmed;
      return trimmed + " 꽉";
    })
    .filter(Boolean)
    .join("\n");
}

function catifyNyang(text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out = lines.map((l) => {
    if (/(냥\??|냐옹\??)\s*$/.test(l)) return l;
    if (/[?？]\s*$/.test(l)) return l.replace(/[?？]\s*$/, "냥?");
    return l + "냥";
  });

  let joined = out.join("\n");
  if (!joined.includes("하라냥") && Math.random() < 0.35) {
    joined = joined.replace(/냥\?$/, "하라냥?");
  }
  return joined;
}

function postProcess(characterId: CharacterId, raw: string) {
  let text = stripMarkdown(raw);
  text = removeSourcesAndUrls(text);

  text = takeFirstSentences(text, 3);
  text = clampLines(text, 4);
  text = ensureConversationalEnding(characterId, text);

  if (characterId === "cat") text = catifyNyang(text);
  if (characterId === "goose") text = endsWithGgakEveryLine(text);

  text = removeSourcesAndUrls(text);
  return text.trim();
}

/** --- “지어내기 금지” 진실성 규칙 --- */
function truthfulnessRules() {
  return [
    "사실을 모르면 절대 지어내지 말고 '확실하지 않다'고 말한다.",
    "학교/실제 정보(규정/운영시간/위치/행사 일정/전화/가격/메뉴 등)는 근거 없으면 단정하지 않는다.",
    "필요하면 웹검색을 사용해 사실을 확인하되, 답변에는 URL/출처/링크를 절대 포함하지 않는다.",
    "검색 결과가 애매하면 단정하지 말고 확인 방법/추가 질문으로 마무리한다.",
    "사용자가 네 답이 틀렸다고 지적하면 즉시 인정하고 정정한다.",
  ].join("\n");
}

function characterStyle(characterId: CharacterId) {
  switch (characterId) {
    case "cow":
      return [
        "밝고 활발, 친구처럼 텐션 높게.",
        "2~3문장으로 짧게, 마지막에 질문 1개.",
        "목록/장문/문서형 설명 금지.",
      ].join("\n");
    case "zara":
      return [
        "느긋하고 상냥하게, 부담 덜어주는 톤.",
        "한 번에 1단계만 제안.",
        "2~3문장 + 질문 1개.",
      ].join("\n");
    case "cat":
      return [
        "완전 귀엽게, 말 끝에 '냥' 붙이기. 가끔 '~하라냥' 섞기.",
        "짧게, 수다하듯.",
        "2~3문장 + 질문 1개.",
      ].join("\n");
    case "goose":
      return [
        "공감/위로 중심. 줄마다 '꽉' 붙이기.",
        "장문 금지. 2~3문장 + 질문 1개.",
      ].join("\n");
    default:
      return "짧게 2~3문장 + 질문 1개로 대화형으로 답해.";
  }
}

/** --- “찾아/검색” 같은 짧은 명령 판별 --- */
function isShortSearchCommand(msg: string) {
  const s = msg.trim();
  return /^(찾아|찾아줘|찾아봐|검색|검색해|검색해줘|서치|서치해|서치해줘)$/i.test(s);
}

/** --- “객관 정보/탐색”이면 웹검색 켜기(강화 휴리스틱) --- */
function needsWebSearch(message: string) {
  const t = message.toLowerCase();

  // ✅ “사용자가 찾아달라/검색”은 무조건 탐색 intent
  const triggerPhrases = [
    "검색",
    "검색해",
    "검색해줘",
    "찾아",
    "찾아줘",
    "찾아봐",
    "서치",
    "네이버",
    "지도",
    "구글맵",
    "근거",
    "정확",
    "실제",
    "진짜",
    "최신",
  ];
  if (triggerPhrases.some((k) => t.includes(k))) return true;

  // ✅ 객관/현실 정보 키워드(장소/가게/운영/규정/일정/가격 등)
  const factualKeywords = [
    // 맛집/장소/영업정보
    "맛집",
    "추천",
    "가게",
    "식당",
    "카페",
    "후문",
    "정문",
    "영업",
    "영업시간",
    "운영시간",
    "몇시",
    "언제",
    "오늘",
    "내일",
    "주소",
    "위치",
    "어디",
    "어딨어",
    "어딘",
    "전화",
    "연락처",
    "가격",
    "요금",
    "비용",
    "메뉴",
    "예약",
    "웨이팅",
    "리뷰",
    "주차",
    "가는법",
    "길",
    "노선",
    "출구",
    "역",
    // 학교/행정/시설
    "학교",
    "건국대",
    "건대",
    "도서관",
    "열람실",
    "프린트",
    "시설",
    "셔틀",
    "학사",
    "등록",
    "등록금",
    "장학",
    "공지",
    "규정",
    "규칙",
    "수칙",
    "학식",
    "식단",
    "운영",
    "시간표",
    "일정",
    "행사",
    "마감",
  ];
  if (factualKeywords.some((k) => t.includes(k))) return true;

  // ✅ 형태 기반 트리거(“~어디/주소/몇시/언제/알려줘/찾아줘”)
  if (/(어디|어딨어|어딘|위치|주소|영업|운영|몇시|언제|알려줘|찾아줘|검색해)/.test(message)) {
    return true;
  }

  return false;
}

/** --- 룰베이스 fallback(짧게) --- */
function replyCowFallback() {
  const openers = ["오케이!!", "좋아좋아!!", "알겠어!!", "바로 도와줄게!!"];
  return `${pick(openers)} 지금 딱 뭐 때문에 막힘?\n(공부/과제/시험/학교정보 중 뭐야?)`;
}
function replyZaraFallback() {
  const soft = ["음… 괜찮아…", "천천히 해도 돼…", "지금부터 정리해도 돼…"];
  return `${pick(soft)} 오늘은 가장 쉬운 한 단계만 하자…\n지금 10분 가능해? 25분 가능해…?`;
}
function replyCatFallback() {
  const base = `야옹… 지금 뭐가 궁금하냥?\n원하는 느낌 말해주라냥 (점심/운세/수다/공부 중에!)`;
  return catifyNyang(base);
}
function replyGooseFallback(user: string) {
  if (user.includes("꽉 빼") || user.includes("꽉하지마")) {
    return "알겠어… 오늘은 ‘꽉’ 없이 말할게 🫂";
  }
  const base = `그거 진짜 힘들었겠다\n지금 네 감정이 뭐가 제일 커…? (불안/분노/지침)\n내가 해결이 필요해, 아니면 위로가 필요해…?`;
  return endsWithGgakEveryLine(base);
}

/** --- OpenAI 설정: 느림 방지 --- */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 25_000,
  maxRetries: 0,
});

/** history 정리(타입/길이/개수 제한) */
function normalizeHistory(raw: unknown): ClientMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientMessage[] = [];

  for (const item of raw) {
    const from = (item as any)?.from;
    const text = (item as any)?.text;

    if ((from !== "user" && from !== "bot") || typeof text !== "string") continue;

    const trimmed = text.trim();
    if (!trimmed) continue;

    out.push({ from, text: trimmed.slice(0, 600) });
  }

  return out.slice(-12);
}

/** "찾아/검색"만 들어오면 직전 유저 질문을 끌어와서 실제 검색 쿼리로 치환 */
function resolveEffectiveMessage(message: string, history: ClientMessage[]) {
  let effective = message.trim();
  if (!isShortSearchCommand(effective)) return effective;

  // history 끝에는 보통 '찾아'가 이미 들어있으니,
  // 그 전의 "의미 있는" 사용자 질문을 찾는다.
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.from !== "user") continue;
    const t = h.text.trim();
    if (!t) continue;
    if (isShortSearchCommand(t)) continue;
    if (t.length < 4) continue;

    effective = `${t}\n(사용자가 '찾아/검색'이라고 했으니 실제로 찾아서 알려줘)`;
    break;
  }

  return effective;
}

/** 모델 input 구성: history + 현재 메시지(중복 제거) */
function buildConversationInput(history: ClientMessage[], message: string) {
  const lines: string[] = [];

  const msg = message.trim();
  const last = history[history.length - 1];
  const messageIsAlreadyLastUser =
    last?.from === "user" && typeof last?.text === "string" && last.text.trim() === msg;

  const merged = messageIsAlreadyLastUser ? history : [...history, { from: "user", text: msg }];

  lines.push("[대화 기록]");
  for (const m of merged) {
    lines.push(`${m.from === "user" ? "사용자" : "너"}: ${m.text}`);
  }
  lines.push("");
  lines.push(
    "[지침] 대화 기록을 참고해서 직전 맥락을 이어서 답하고, 사용자가 정정하면 즉시 인정하고 수정해."
  );

  return lines.join("\n");
}

async function replyWithOpenAI(characterId: CharacterId, userMessage: string, history: ClientMessage[]) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");

  const character = getCharacter(characterId);
  if (!character) throw new Error("Invalid characterId");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  // ✅ 실제로 모델에 들어가는 메시지(찾아/검색 보정 포함)
  const effectiveMessage = resolveEffectiveMessage(userMessage, history);

  // ✅ web_search 조건은 effectiveMessage 기준으로 판단 (중요)
  const enableWebSearch = needsWebSearch(effectiveMessage);

  const instructions =
    `너는 '건국대학교 마스코트 캐릭터 챗봇'이다.\n` +
    `캐릭터 이름: ${character.name}\n` +
    `캐릭터 설명/말투 참고:\n${character.persona}\n\n` +
    `말투 지침:\n${characterStyle(characterId)}\n\n` +
    `진실성 규칙:\n${truthfulnessRules()}\n\n` +
    `출력 규칙(매우 중요):\n` +
    `- 한국어로만.\n` +
    `- 2~4줄, 최대 3문장 + 질문 1개 정도.\n` +
    `- 목록/장문/문서형 설명 금지.\n` +
    `- 객관 정보(맛집/학교/영업시간/위치/규정/일정/가격/전화 등)는 반드시 웹검색으로 확인 후 답한다.\n` +
    `- 하지만 답변에는 URL/링크/출처/도메인/괄호 링크를 절대 포함하지 않는다.\n` +
    `- 링크를 말하고 싶다면 "공식 홈페이지/지도/공지에서 확인해줘"처럼 말로만 안내한다.\n` +
    `- 사용자가 네 답이 틀렸다고 하면 변명하지 말고 바로 인정하고 고쳐라.\n` +
    `- 웹검색 결과가 불확실하면 단정하지 말고 '확실하지 않다'고 말하고 확인 방법을 안내해.\n`;

  const input = buildConversationInput(history, effectiveMessage);

  const resp = await openai.responses.create({
    model,
    instructions,
    input,
    max_output_tokens: 240,
    store: false,
    tools: enableWebSearch ? [{ type: "web_search" as const }] : undefined,
  });

  const raw = resp.output_text ?? "";
  if (!raw.trim()) throw new Error("Empty model output");

  const reply = postProcess(characterId, raw);
  return { reply, sources: [], used_web_search: enableWebSearch };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = String(body?.message ?? "").trim();
    const characterId = String(body?.characterId ?? "") as CharacterId;

    // ✅ ChatClient에서 보내는 history 받기
    const history = normalizeHistory(body?.history);

    if (!message) {
      return Response.json({
        reply: "음… 메시지가 비어있어 😵‍💫",
        sources: [],
        used_web_search: false,
        used_fallback: true,
      });
    }

    // “꽉 빼” 같은 사용자의 명시적 요청은 최우선 반영
    if (characterId === "goose" && (message.includes("꽉 빼") || message.includes("꽉하지마"))) {
      return Response.json({
        reply: "알겠어… 오늘은 ‘꽉’ 없이 말할게 🫂",
        sources: [],
        used_web_search: false,
        used_fallback: true,
      });
    }

    // OpenAI 시도
    if (process.env.OPENAI_API_KEY) {
      try {
        const r = await replyWithOpenAI(characterId, message, history);
        return Response.json({ ...r, used_fallback: false });
      } catch (e: any) {
        // console.error("OpenAI failed:", e?.message);
      }
    }

    // fallback(키 없거나 실패)
    let reply = "";
    switch (characterId) {
      case "cow":
        reply = replyCowFallback();
        break;
      case "zara":
        reply = replyZaraFallback();
        break;
      case "cat":
        reply = replyCatFallback();
        break;
      case "goose":
        // ✅ 여기서도 effectiveMessage 쓰면 자연스러운데,
        // fallback은 검색이 안 되니 원문 유지해도 됨. 그래도 '찾아'면 이전 질문을 잡아주게 처리:
        reply = replyGooseFallback(resolveEffectiveMessage(message, history));
        break;
      default:
        reply = "앗… 캐릭터 id가 이상해 😵‍💫 (cow/zara/cat/goose 중 하나여야 해!)";
        break;
    }

    return Response.json({ reply, sources: [], used_web_search: false, used_fallback: true });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "unknown error" }, { status: 500 });
  }
}
